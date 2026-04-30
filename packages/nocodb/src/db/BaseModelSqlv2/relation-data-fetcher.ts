import groupBy from 'lodash/groupBy';
import { extractFilterFromXwhere, NcApiVersion } from 'nocodb-sdk';
import type { NcContext } from 'nocodb-sdk';
import type { Logger } from '@nestjs/common';
import type { IBaseModelSqlV2 } from '~/db/IBaseModelSqlV2';
import type { LinkToAnotherRecordColumn } from '~/models';
import conditionV2 from '~/db/conditionV2';
import sortV2 from '~/db/sortV2';
import { _wherePk, applyPaginate } from '~/helpers/dbHelpers';
import getAst from '~/helpers/getAst';
import { Filter, Model, View } from '~/models';
import { hasTableVisibilityAccess } from '~/helpers/tableHelpers';
import Noco from '~/Noco';
import { nocoExecute } from '~/utils/nocoExecute';

const GROUP_COL = '__nc_group_id';

export const relationDataFetcher = (param: {
  baseModel: IBaseModelSqlV2;
  logger: Logger;
}) => {
  const { baseModel } = param;

  async function postProcessData(
    context: NcContext,
    {
      data,
      model,
      query,
    }: {
      data: any[];
      model: Model;
      query: any;
    },
  ) {
    if (Noco.isEE()) {
      return data;
    }

    const { ast, parsedQuery } = await getAst(context, {
      model,
      query,
      extractOnlyPrimaries:
        context.cacheMap?.get('relation_postProcessData') ?? false,
    });

    if (!context.cacheMap) {
      context.cacheMap = new Map();
    }
    // set context.cacheMap `relation_postProcessData` to ensure non-infinite loop
    context.cacheMap.set('relation_postProcessData', true);

    // nocoexecute
    const result = await nocoExecute(ast, data, {}, parsedQuery);
    return result;
  }

  return {
    async multipleHmList(
      {
        colId,
        ids: _ids,
        apiVersion,
        nested = false,
        linksAsLtar = false,
      }: {
        colId: string;
        ids: any[];
        apiVersion?: NcApiVersion;
        nested?: boolean;
        linksAsLtar?: boolean;
      },
      args: { limit?; offset?; fieldsSet?: Set<string> } = {},
    ) {
      try {
        // skip duplicate id
        const ids = [...new Set(_ids)];

        const { where, sort, ...rest } = baseModel._getListArgs(args as any);
        // todo: get only required fields
        const relColumn = (await baseModel.model.getColumns()).find(
          (c) => c.id === colId,
        );

        const relationColOpts =
          (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

        const { refContext } = relationColOpts.getRelContext();

        const childCol = await relationColOpts.getChildColumn();

        const childTable = await childCol.getModel();
        const parentCol = await relationColOpts.getParentColumn();
        const parentTable = await parentCol.getModel();
        const childBaseModel = await Model.getBaseModelSQL(refContext, {
          model: childTable,
          dbDriver: baseModel.dbDriver,
        });
        await parentTable.getColumns();

        const childTn = childBaseModel.getTnPath(childTable);
        const parentTn = baseModel.getTnPath(parentTable);

        const qb = childBaseModel.dbDriver(childTn);

        const hasLimitedAccess = !(await hasTableVisibilityAccess(
          baseModel.context,
          childTable.id,
          baseModel.context.user,
        ));

        await childBaseModel.selectObject({
          qb,
          extractPkAndPv: true,
          fieldsSet: args.fieldsSet,
          pkAndPvOnly: relationColOpts.isCrossBaseLink() || hasLimitedAccess,
          linksAsLtar,
        });
        const view = relationColOpts.fk_target_view_id
          ? await View.get(refContext, relationColOpts.fk_target_view_id)
          : await View.getFirstCollaborativeView(
              refContext,
              childBaseModel.model.id,
            );
        await childBaseModel.applySortAndFilter({
          table: childTable,
          where,
          qb,
          sort,
          view,
          skipViewFilter: true,
          prioritizePvSort: true,
        });

        // Exclude soft-deleted records from HM results so they don't leak through links
        const hmSoftDeleteFilter = await childBaseModel.getSoftDeleteFilter();
        if (hmSoftDeleteFilter) qb.where(hmSoftDeleteFilter);

        const childQb = baseModel.dbDriver.queryBuilder().from(
          baseModel.dbDriver
            .unionAll(
              ids.map((p) => {
                const query = qb
                  .clone()
                  .select(baseModel.dbDriver.raw('? as ??', [p, GROUP_COL]))
                  .whereIn(
                    childCol.column_name,
                    baseModel
                      .dbDriver(parentTn)
                      .select(parentCol.column_name)
                      // .where(parentTable.primaryKey.cn, p)
                      .where(_wherePk(parentTable.primaryKeys, p)),
                  );
                // todo: sanitize

                // get one extra record to check if there are more records in case of v3 api and nested
                query.limit(
                  (+rest?.limit || 25) +
                    (apiVersion === NcApiVersion.V3 && nested ? 1 : 0),
                );
                query.offset(+rest?.offset || 0);

                return baseModel.isSqlite
                  ? baseModel.dbDriver.select().from(query)
                  : query;
              }),
              !baseModel.isSqlite,
            )
            .as('list'),
        );

        const children = await childBaseModel.execAndParse(
          childQb,
          await childTable.getColumns(),
        );
        const proto = await childBaseModel.getProto();

        return groupBy(
          children.map((c) => {
            c.__proto__ = proto;
            return c;
          }),
          GROUP_COL,
        );
      } catch (e) {
        param.logger.error(e);
      }
    },

    async mmList(
      {
        colId,
        parentId,
        apiVersion,
        nested = false,
        linksAsLtar = false,
      }: {
        colId: string;
        parentId: any;
        apiVersion?: NcApiVersion;
        nested?: boolean;
        linksAsLtar?: boolean;
      },
      args: { limit?; offset?; fieldsSet?: Set<string> } = {},
      selectAllRecords = false,
    ) {
      const { where, sort, ...rest } = baseModel._getListArgs(args as any, {
        apiVersion,
        nested: true,
      });
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );

      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { refContext, mmContext } = relColOptions.getRelContext();

      // const tn = baseModel.model.tn;
      // const cn = (await relColOptions.getChildColumn()).title;
      const mmTable = await relColOptions.getMMModel();

      // if mm table is not present then return
      if (!mmTable) {
        return [];
      }

      const mmBaseModel = await Model.getBaseModelSQL(mmContext, {
        model: mmTable,
        dbDriver: baseModel.dbDriver,
      });
      const vtn = mmBaseModel.getTnPath(mmTable);
      const vcn = (await relColOptions.getMMChildColumn()).column_name;
      const vrcn = (await relColOptions.getMMParentColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;
      const cn = (await relColOptions.getChildColumn()).column_name;
      const refTable = await (await relColOptions.getParentColumn()).getModel();
      const table = await (await relColOptions.getChildColumn()).getModel();
      await table.getColumns();
      const refBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: refTable,
      });

      const refTn = refBaseModel.getTnPath(refTable);
      const tn = baseModel.getTnPath(table);

      const rtn = refTn;
      // const rtnId = childTable.id;

      const qb = baseModel
        .dbDriver(rtn)
        .join(vtn, `${vtn}.${vrcn}`, `${rtn}.${rcn}`)
        .whereIn(
          `${vtn}.${vcn}`,
          baseModel
            .dbDriver(tn)
            .select(cn)
            // .where(parentTable.primaryKey.cn, id)
            .where(_wherePk(table.primaryKeys, parentId)),
        );

      const hasLimitedAccess = !(await hasTableVisibilityAccess(
        baseModel.context,
        refTable.id,
        baseModel.context.user,
      ));

      await refBaseModel.selectObject({
        qb,
        fieldsSet: args.fieldsSet,
        pkAndPvOnly: relColOptions.isCrossBaseLink() || hasLimitedAccess,
        linksAsLtar,
      });

      await refTable.getViews();
      const viewId =
        relColumn.colOptions?.fk_target_view_id ?? refTable.views?.[0]?.id;
      let view: View | null = null;
      if (viewId) view = await View.get(refContext, viewId);

      await refBaseModel.applySortAndFilter({
        table: refTable,
        where,
        view,
        qb,
        sort,
        skipViewFilter: true,
        prioritizePvSort: true,
      });

      if (!sort || sort === '') {
        const view = relColOptions.fk_target_view_id
          ? await View.get(refContext, relColOptions.fk_target_view_id)
          : await View.getFirstCollaborativeView(refContext, refTable.id);
        if (view) {
          const childSorts = await view.getSorts();
          await sortV2(refBaseModel, childSorts, qb);
        }
      }

      // todo: sanitize
      if (!selectAllRecords) {
        // get one extra record to check if there are more records in case of v3 api and nested
        qb.limit(
          (+rest?.limit || 25) +
            (apiVersion === NcApiVersion.V3 && nested ? 1 : 0),
        );
      }
      qb.offset(selectAllRecords ? 0 : +rest?.offset || 0);

      // Exclude soft-deleted records from MM results so they don't leak through links
      const mmSoftDeleteFilter = await refBaseModel.getSoftDeleteFilter();
      if (mmSoftDeleteFilter) qb.where(mmSoftDeleteFilter);

      const children = await refBaseModel.execAndParse(
        qb,
        await refTable.getColumns(),
      );
      const proto = await refBaseModel.getProto();

      return await postProcessData(refContext, {
        data: children.map((c) => {
          c.__proto__ = proto;
          return c;
        }),
        model: refTable,
        query: args,
      });
    },

    // Like mmList but returns a single record (for V2 MO/OO — single-target relations via junction table)
    async mmRead(
      {
        colId,
        parentId,
      }: {
        colId: string;
        parentId: any;
      },
      args: { fieldsSet?: Set<string> } = {},
    ) {
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );

      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { refContext, mmContext } = relColOptions.getRelContext();

      const mmTable = await relColOptions.getMMModel();

      // if mm table is not present then return
      if (!mmTable) {
        return null;
      }

      const mmBaseModel = await Model.getBaseModelSQL(mmContext, {
        model: mmTable,
        dbDriver: baseModel.dbDriver,
      });
      const vtn = mmBaseModel.getTnPath(mmTable);
      const vcn = (await relColOptions.getMMChildColumn()).column_name;
      const vrcn = (await relColOptions.getMMParentColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;
      const cn = (await relColOptions.getChildColumn()).column_name;
      const refTable = await (await relColOptions.getParentColumn()).getModel();
      const table = await (await relColOptions.getChildColumn()).getModel();
      await table.getColumns();
      const refBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: refTable,
      });

      const refTn = refBaseModel.getTnPath(refTable);
      const tn = baseModel.getTnPath(table);
      const rtn = refTn;

      const qb = baseModel
        .dbDriver(rtn)
        .join(vtn, `${vtn}.${vrcn}`, `${rtn}.${rcn}`)
        .whereIn(
          `${vtn}.${vcn}`,
          baseModel
            .dbDriver(tn)
            .select(cn)
            .where(_wherePk(table.primaryKeys, parentId)),
        )
        .limit(1);

      // Exclude soft-deleted records from MM read results
      const refSoftDeleteFilter = await refBaseModel.getSoftDeleteFilter();
      if (refSoftDeleteFilter) {
        qb.where(refSoftDeleteFilter);
      }

      const hasLimitedAccess = !(await hasTableVisibilityAccess(
        baseModel.context,
        refTable.id,
        baseModel.context.user,
      ));

      await refBaseModel.selectObject({
        qb,
        fieldsSet: args.fieldsSet,
        pkAndPvOnly: relColOptions.isCrossBaseLink() || hasLimitedAccess,
      });

      const child = await refBaseModel.execAndParse(
        qb,
        await refTable.getColumns(),
        { first: true },
      );

      if (!child) return null;

      const proto = await refBaseModel.getProto();
      child.__proto__ = proto;

      const result = await postProcessData(refContext, {
        data: [child],
        model: refTable,
        query: args,
      });

      return result?.[0] ?? null;
    },

    async multipleHmListCount({ colId, ids }) {
      try {
        // const { cn } = baseModel.hasManyRelations.find(({ tn }) => tn === child) || {};
        const relColumn = (await baseModel.model.getColumns()).find(
          (c) => c.id === colId,
        );

        const relationColOpts =
          (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

        const childCol = await relationColOpts.getChildColumn();

        const childTable = await childCol.getModel();

        const parentCol = await relationColOpts.getParentColumn();

        const parentTable = await parentCol.getModel();

        await parentTable.getColumns();

        const childBaseModel = await Model.getBaseModelSQL(baseModel.context, {
          dbDriver: baseModel.dbDriver,
          model: childTable,
        });

        const childTn = childBaseModel.getTnPath(childTable);
        const parentTn = baseModel.getTnPath(parentTable);

        // Exclude soft-deleted records from HM count results
        const hmCountSoftDeleteFilter =
          await childBaseModel.getSoftDeleteFilter();

        const children = await childBaseModel.execAndParse(
          childBaseModel.dbDriver.unionAll(
            ids.map((p) => {
              const query = baseModel
                .dbDriver(childTn)
                .count(`${childCol?.column_name} as count`)
                .whereIn(
                  childCol.column_name,
                  baseModel
                    .dbDriver(parentTn)
                    .select(parentCol.column_name)
                    // .where(parentTable.primaryKey.cn, p)
                    .where(_wherePk(parentTable.primaryKeys, p)),
                )
                .first();

              if (hmCountSoftDeleteFilter) query.where(hmCountSoftDeleteFilter);

              return childBaseModel.isSqlite
                ? childBaseModel.dbDriver.select().from(query)
                : query;
            }),
            !childBaseModel.isSqlite,
          ),
          null,
          { raw: true },
        );

        return children.map(({ count }) => count);
      } catch (e) {
        throw e;
      }
    },

    async hmList(
      {
        colId,
        id,
        apiVersion,
        linksAsLtar = false,
      }: {
        colId: string;
        id: any;
        apiVersion?: NcApiVersion;
        nested?: boolean;
        linksAsLtar?: boolean;
      },
      args: { limit?; offset?; fieldSet?: Set<string> } = {},
    ) {
      try {
        const { where, sort, ...rest } = baseModel._getListArgs(args as any, {
          apiVersion,
          nested: true,
        });
        // todo: get only required fields

        const relColumn = (await baseModel.model.getColumns()).find(
          (c) => c.id === colId,
        );
        const relationColOpts =
          (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

        const { refContext } = relationColOpts.getRelContext();

        const childCol = await relationColOpts.getChildColumn();

        const childTable = await childCol.getModel();

        const parentCol = await relationColOpts.getParentColumn();
        const parentTable = await parentCol.getModel();
        const childBaseModel = await Model.getBaseModelSQL(refContext, {
          model: childTable,
          dbDriver: baseModel.dbDriver,
        });
        await parentTable.getColumns();

        const childTn = childBaseModel.getTnPath(childTable);
        const parentTn = baseModel.getTnPath(parentTable);

        const qb = baseModel.dbDriver(childTn);

        await childTable.getViews();
        const viewId =
          relColumn.colOptions?.fk_target_view_id ?? childTable.views?.[0]?.id;
        let view: View | null = null;
        if (viewId) view = await View.get(childBaseModel.context, viewId);

        qb.whereIn(
          childCol.column_name,
          baseModel
            .dbDriver(parentTn)
            .select(parentCol.column_name)
            // .where(parentTable.primaryKey.cn, p)
            .where(_wherePk(parentTable.primaryKeys, id)),
        );
        // todo: sanitize
        qb.limit(+rest?.limit || 25);
        qb.offset(+rest?.offset || 0);

        const hasLimitedAccess = !(await hasTableVisibilityAccess(
          baseModel.context,
          childTable.id,
          baseModel.context.user,
        ));

        await childBaseModel.selectObject({
          qb,
          fieldsSet: args.fieldSet,
          pkAndPvOnly: relationColOpts.isCrossBaseLink() || hasLimitedAccess,
          linksAsLtar,
        });

        await childBaseModel.applySortAndFilter({
          table: childTable,
          where,
          qb,
          sort,
          view,
          skipViewFilter: true,
          prioritizePvSort: true,
        });

        const hmListSoftDeleteFilter =
          await childBaseModel.getSoftDeleteFilter();
        if (hmListSoftDeleteFilter) qb.where(hmListSoftDeleteFilter);

        const children = await childBaseModel.execAndParse(
          qb,
          await childTable.getColumns(),
        );

        const proto = await childBaseModel.getProto();

        return await postProcessData(refContext, {
          data: children.map((c) => {
            c.__proto__ = proto;
            return c;
          }),
          model: childTable,
          query: args,
        });
      } catch (e) {
        throw e;
      }
    },

    async hmListCount({ colId, id }, args) {
      try {
        // const { cn } = baseModel.hasManyRelations.find(({ tn }) => tn === child) || {};
        const { where } = baseModel._getListArgs(args as any);
        const relColumn = (await baseModel.model.getColumns()).find(
          (c) => c.id === colId,
        );

        const relationColOpts =
          (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

        const childCol = await relationColOpts.getChildColumn();

        const { refContext } = relationColOpts.getRelContext();

        const childTable = await childCol.getModel();
        const parentCol = await (
          (await relColumn.getColOptions()) as LinkToAnotherRecordColumn
        ).getParentColumn();
        const parentTable = await parentCol.getModel();
        await parentTable.getColumns();

        const childBaseModel = await Model.getBaseModelSQL(refContext, {
          dbDriver: baseModel.dbDriver,
          model: childTable,
        });
        const childTn = childBaseModel.getTnPath(childTable);
        const parentTn = baseModel.getTnPath(parentTable);

        const query = childBaseModel
          .dbDriver(childTn)
          .count(`${childCol?.column_name} as count`)
          .whereIn(
            childCol.column_name,
            baseModel
              .dbDriver(parentTn)
              .select(parentCol.column_name)
              .where(_wherePk(parentTable.primaryKeys, id)),
          );

        // Exclude soft-deleted records from HM count results
        const hmCountSoftDeleteFilter =
          await childBaseModel.getSoftDeleteFilter();
        if (hmCountSoftDeleteFilter) query.where(hmCountSoftDeleteFilter);

        const aliasColObjMap = await childTable.getAliasColObjMap();
        const { filters: filterObj } = extractFilterFromXwhere(
          childBaseModel.context,
          where,
          aliasColObjMap,
        );

        await conditionV2(
          // cast as any before further refactor
          childBaseModel as any,
          [
            new Filter({
              children: filterObj,
              is_group: true,
              logical_op: 'and',
            }),
          ],
          query,
        );

        return (
          await childBaseModel.execAndParse(query, null, {
            raw: true,
            first: true,
          })
        )?.count;
      } catch (e) {
        throw e;
      }
    },

    async multipleMmList(
      {
        colId,
        parentIds: _parentIds,
        apiVersion,
        nested = false,
        linksAsLtar = false,
      }: {
        colId: string;
        parentIds: any[];
        apiVersion?: NcApiVersion;
        nested?: boolean;
        linksAsLtar?: boolean;
      },
      args: { limit?; offset?; fieldsSet?: Set<string> } = {},
    ) {
      // skip duplicate id
      const parentIds = [...new Set(_parentIds)];
      const { where, sort, ...rest } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      // const tn = baseModel.model.tn;
      // const cn = (await relColOptions.getChildColumn()).title;
      const mmTable = await relColOptions.getMMModel();

      // if mm table is not present then return
      if (!mmTable) {
        return;
      }

      const vcn = (await relColOptions.getMMChildColumn()).column_name;
      const vrcn = (await relColOptions.getMMParentColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;
      const cn = (await relColOptions.getChildColumn()).column_name;

      const { refContext, mmContext } = relColOptions.getRelContext();

      const refTable = await (await relColOptions.getParentColumn()).getModel();
      const table = await (await relColOptions.getChildColumn()).getModel();
      await table.getColumns();
      const refBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: refTable,
      });
      const mmModel = await Model.getBaseModelSQL(mmContext, {
        dbDriver: baseModel.dbDriver,
        model: mmTable,
      });

      const refTn = refBaseModel.getTnPath(refTable);
      const tn = baseModel.getTnPath(table);
      const vtn = mmModel.getTnPath(mmTable);
      const rtn = refTn;

      const qb = baseModel
        .dbDriver(rtn)
        .join(vtn, `${vtn}.${vrcn}`, `${rtn}.${rcn}`);

      const hasLimitedAccess = !(await hasTableVisibilityAccess(
        baseModel.context,
        refTable.id,
        baseModel.context.user,
      ));

      await refBaseModel.selectObject({
        qb,
        fieldsSet: args.fieldsSet,
        pkAndPvOnly: relColOptions.isCrossBaseLink() || hasLimitedAccess,
        linksAsLtar,
      });

      const view = relColOptions.fk_target_view_id
        ? await View.get(refContext, relColOptions.fk_target_view_id)
        : await View.getFirstCollaborativeView(refContext, refTable.id);
      await refBaseModel.applySortAndFilter({
        table: refTable,
        where,
        qb,
        sort,
        view,
        skipViewFilter: true,
        prioritizePvSort: true,
      });

      const mmListSoftDeleteFilter = await refBaseModel.getSoftDeleteFilter();

      const finalQb = refBaseModel.dbDriver.unionAll(
        parentIds.map((id) => {
          const query = qb
            .clone()
            .whereIn(
              `${vtn}.${vcn}`,
              baseModel
                .dbDriver(tn)
                .select(cn)
                // .where(parentTable.primaryKey.cn, id)
                .where(_wherePk(table.primaryKeys, id)),
            )
            .select(baseModel.dbDriver.raw('? as ??', [id, GROUP_COL]));

          if (mmListSoftDeleteFilter) query.where(mmListSoftDeleteFilter);

          // get one extra record to check if there are more records in case of v3 api and nested
          query.limit(
            (+rest?.limit || 25) +
              (apiVersion === NcApiVersion.V3 && nested ? 1 : 0),
          );
          query.offset(+rest?.offset || 0);
          return baseModel.isSqlite
            ? baseModel.dbDriver.select().from(query)
            : query;
        }),
        !baseModel.isSqlite,
      );

      const children = await refBaseModel.execAndParse(
        finalQb,
        await refTable.getColumns(),
      );

      const proto = await refBaseModel.getProto();
      const gs = groupBy(
        children.map((c) => {
          c.__proto__ = proto;
          return c;
        }),
        GROUP_COL,
      );
      return _parentIds.map((id) => gs[id] || []);
    },

    async multipleMmListCount({ colId, parentIds }) {
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const mmTable = await relColOptions.getMMModel();

      // if mm table is not present then return
      if (!mmTable) {
        return parentIds.map(() => 0);
      }

      const vtn = baseModel.getTnPath(mmTable);
      const vcn = (await relColOptions.getMMChildColumn()).column_name;
      const vrcn = (await relColOptions.getMMParentColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;
      const cn = (await relColOptions.getChildColumn()).column_name;
      const childTable = await (
        await relColOptions.getParentColumn()
      ).getModel();
      const parentTable = await (
        await relColOptions.getChildColumn()
      ).getModel();
      await parentTable.getColumns();

      const childTn = baseModel.getTnPath(childTable);
      const parentTn = baseModel.getTnPath(parentTable);

      const rtn = childTn;

      const refBaseModel = await Model.getBaseModelSQL(baseModel.context, {
        dbDriver: baseModel.dbDriver,
        model: childTable,
      });

      const qb = baseModel
        .dbDriver(rtn)
        .join(vtn, `${vtn}.${vrcn}`, `${rtn}.${rcn}`)
        // .select({
        //   [`${tn}_${vcn}`]: `${vtn}.${vcn}`
        // })
        .count(`${vtn}.${vcn}`, { as: 'count' });

      // Exclude soft-deleted records from MM count results
      const mmCountSoftDeleteFilter = await refBaseModel.getSoftDeleteFilter();
      if (mmCountSoftDeleteFilter) qb.where(mmCountSoftDeleteFilter);

      // await childBaseModel.selectObject({ qb });
      const children = await baseModel.execAndParse(
        baseModel.dbDriver.unionAll(
          parentIds.map((id) => {
            const query = qb
              .clone()
              .whereIn(
                `${vtn}.${vcn}`,
                baseModel
                  .dbDriver(parentTn)
                  .select(cn)
                  // .where(parentTable.primaryKey.cn, id)
                  .where(_wherePk(parentTable.primaryKeys, id)),
              )
              .select(baseModel.dbDriver.raw('? as ??', [id, GROUP_COL]));
            // baseModel._paginateAndSort(query, { sort, limit, offset }, null, true);
            return baseModel.isSqlite
              ? baseModel.dbDriver.select().from(query)
              : query;
          }),
          !baseModel.isSqlite,
        ),
        null,
        { raw: true },
      );

      const gs = groupBy(children, GROUP_COL);
      return parentIds.map((id) => gs?.[id]?.[0] || []);
    },

    async mmListCount({ colId, parentId }, args) {
      const { where } = baseModel._getListArgs(args as any);

      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { mmContext, refContext } = relColOptions.getRelContext();

      const mmTable = await relColOptions.getMMModel();

      // if mm table is not present then return
      if (!mmTable) {
        return 0;
      }

      const assocBaseModel = await Model.getBaseModelSQL(mmContext, {
        model: mmTable,
        dbDriver: baseModel.dbDriver,
      });

      const vtn = assocBaseModel.getTnPath(mmTable);
      const vcn = (await relColOptions.getMMChildColumn()).column_name;
      const vrcn = (await relColOptions.getMMParentColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;

      const cn = (await relColOptions.getChildColumn()).column_name;
      const refTable = await (await relColOptions.getParentColumn()).getModel();

      const table = await (await relColOptions.getChildColumn()).getModel();
      await table.getColumns();

      const childBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: refTable,
      });

      const childTn = childBaseModel.getTnPath(refTable);
      const parentTn = baseModel.getTnPath(table);

      const rtn = childTn;

      const qb = baseModel
        .dbDriver(rtn)
        .join(vtn, `${vtn}.${vrcn}`, `${rtn}.${rcn}`)
        // .select({
        //   [`${tn}_${vcn}`]: `${vtn}.${vcn}`
        // })
        .count(`${vtn}.${vcn}`, { as: 'count' })
        .whereIn(
          `${vtn}.${vcn}`,
          baseModel
            .dbDriver(parentTn)
            .select(cn)
            // .where(table.primaryKey.cn, id)
            .where(_wherePk(table.primaryKeys, parentId)),
        );

      // Exclude soft-deleted records from MM count results
      const mmCountSoftDeleteFilter =
        await childBaseModel.getSoftDeleteFilter();
      if (mmCountSoftDeleteFilter) qb.where(mmCountSoftDeleteFilter);

      const aliasColObjMap = await refTable.getAliasColObjMap();
      const { filters: filterObj } = extractFilterFromXwhere(
        refContext,
        where,
        aliasColObjMap,
      );

      await conditionV2(
        // cast as any before further refactor
        baseModel as any,
        [
          new Filter({
            children: filterObj,
            is_group: true,
            logical_op: 'and',
          }),
        ],
        qb,
      );
      return (
        await baseModel.execAndParse(qb, null, { raw: true, first: true })
      )?.count;
    },

    async getMmChildrenExcludedListCount(
      { colId, pid = null },
      args,
    ): Promise<any> {
      const { where } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { refContext, mmContext } = relColOptions.getRelContext();

      const mmTable = await relColOptions.getMMModel();

      // if mm table is not present then return
      if (!mmTable) {
        return 0;
      }
      const assocBaseModel = await Model.getBaseModelSQL(mmContext, {
        id: mmTable.id,
        dbDriver: baseModel.dbDriver,
      });

      const vtn = assocBaseModel.getTnPath(mmTable);
      const vcn = (await relColOptions.getMMChildColumn()).column_name;
      const vrcn = (await relColOptions.getMMParentColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;
      const cn = (await relColOptions.getChildColumn()).column_name;
      const childTable = await (
        await relColOptions.getParentColumn()
      ).getModel();

      const childBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: childTable,
      });

      const childView = await relColOptions.getChildView(childTable);
      let listArgs: any = {};
      if (childView) {
        const { dependencyFields } = await getAst(childBaseModel.context, {
          model: childTable,
          query: {},
          view: childView,
          throwErrorIfInvalidParams: false,
        });

        listArgs = dependencyFields;
        try {
          listArgs.filterArr = JSON.parse(listArgs.filterArrJson);
        } catch (e) {}
        try {
          listArgs.sortArr = JSON.parse(listArgs.sortArrJson);
        } catch (e) {}
      }

      const parentTable = await (
        await relColOptions.getChildColumn()
      ).getModel();
      await parentTable.getColumns();

      const parentBaseModel = await Model.getBaseModelSQL(baseModel.context, {
        id: parentTable.id,
        dbDriver: baseModel.dbDriver,
      });
      const childTn = childBaseModel.getTnPath(childTable);
      const parentTn = parentBaseModel.getTnPath(parentTable);

      const rtn = childTn;
      const qb = baseModel
        .dbDriver(rtn)
        .count(`*`, { as: 'count' })
        .where((qb) => {
          qb.whereNotIn(
            rcn,
            baseModel
              .dbDriver(rtn)
              .select(`${rtn}.${rcn}`)
              .join(vtn, `${rtn}.${rcn}`, `${vtn}.${vrcn}`)
              .whereIn(
                `${vtn}.${vcn}`,
                baseModel
                  .dbDriver(parentTn)
                  .select(cn)
                  // .where(parentTable.primaryKey.cn, pid)
                  .where(_wherePk(parentTable.primaryKeys, pid)),
              ),
          ).orWhereNull(rcn);
        });

      // Exclude soft-deleted records from MM excluded count results
      const mmExclCountSoftDeleteFilter =
        await childBaseModel.getSoftDeleteFilter();
      if (mmExclCountSoftDeleteFilter) qb.where(mmExclCountSoftDeleteFilter);

      const aliasColObjMap = await childTable.getAliasColObjMap();
      const { filters: filterObj } = extractFilterFromXwhere(
        childBaseModel.context,
        where,
        aliasColObjMap,
      );

      await childBaseModel.getCustomConditionsAndApply({
        column: relColumn,
        view: childView,
        filters: filterObj,
        args,
        qb,
        rowId: pid,
      });

      return (
        await childBaseModel.execAndParse(qb, await childTable.getColumns(), {
          raw: true,
          first: true,
        })
      )?.count;
    },

    async getMmChildrenExcludedList({ colId, pid = null }, args): Promise<any> {
      const { where, sort, ...rest } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const mmTable = await relColOptions.getMMModel();

      // if mm table is not present then return
      if (!mmTable) {
        return [];
      }

      const context = baseModel.context;
      const { refContext, mmContext } = relColOptions.getRelContext();

      const assocBaseModel = await Model.getBaseModelSQL(mmContext, {
        id: mmTable.id,
        dbDriver: baseModel.dbDriver,
      });

      const vtn = assocBaseModel.getTnPath(mmTable);
      const vcn = (await relColOptions.getMMChildColumn()).column_name;
      const vrcn = (await relColOptions.getMMParentColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;
      const cn = (await relColOptions.getChildColumn()).column_name;

      const refTable = await (await relColOptions.getParentColumn()).getModel();
      const table = await (await relColOptions.getChildColumn()).getModel();
      await table.getColumns();

      const refBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        id: refTable.id,
      });
      const refTn = refBaseModel.getTnPath(refTable);
      const tn = baseModel.getTnPath(table);

      const refView = await relColOptions.getChildView(refTable);
      let listArgs: any = {};

      const hasLimitedAccess = !(await hasTableVisibilityAccess(
        baseModel.context,
        refTable.id,
        context.user,
      ));

      if (refView) {
        const { dependencyFields } = await getAst(refContext, {
          model: refTable,
          query: {},
          view: hasLimitedAccess ? null : refView,
          throwErrorIfInvalidParams: false,
          extractOnlyPrimaries: hasLimitedAccess,
        });
        listArgs = dependencyFields;
      }

      const rtn = refTn;

      const qb = refBaseModel.dbDriver(rtn).where((qb) =>
        qb
          .whereNotIn(
            rcn,
            baseModel
              .dbDriver(rtn)
              .select(`${rtn}.${rcn}`)
              .join(vtn, `${rtn}.${rcn}`, `${vtn}.${vrcn}`)
              .whereIn(
                `${vtn}.${vcn}`,
                baseModel
                  .dbDriver(tn)
                  .select(cn)
                  // .where(parentTable.primaryKey.cn, pid)
                  .where(_wherePk(table.primaryKeys, pid)),
              ),
          )
          .orWhereNull(rcn),
      );

      if (+rest?.shuffle) {
        await this.shuffle({ qb });
      }

      // Exclude soft-deleted records from MM excluded list results
      const mmExclListSoftDeleteFilter =
        await refBaseModel.getSoftDeleteFilter();
      if (mmExclListSoftDeleteFilter) qb.where(mmExclListSoftDeleteFilter);

      await refBaseModel.selectObject({
        qb,
        fieldsSet: listArgs?.fieldsSet,
        viewId: refView?.id,
        pkAndPvOnly: relColOptions.isCrossBaseLink() || hasLimitedAccess,
      });

      const aliasColObjMap = await refTable.getAliasColObjMap();
      const { filters: filterObj } = extractFilterFromXwhere(
        refContext,
        where,
        aliasColObjMap,
      );

      await refBaseModel.getCustomConditionsAndApply({
        column: relColumn,
        view: relColOptions.fk_target_view_id ? refView : null,
        filters: filterObj,
        args,
        qb,
        rowId: pid,
      });

      await refBaseModel.applySortAndFilter({
        table: refTable,
        view: refView,
        qb,
        sort,
        where,
        // condition is applied in getCustomConditionsAndApply and we don't want to apply it again
        onlySort: true,
        prioritizePvSort: true,
      });

      applyPaginate(qb, rest);

      const proto = await refBaseModel.getProto();
      const data = await refBaseModel.execAndParse(
        qb,
        await refTable.getColumns(),
      );
      return await postProcessData(refContext, {
        data: data.map((c) => {
          c.__proto__ = proto;
          return c;
        }),
        model: refTable,
        query: args,
      });
    },

    async getHmChildrenExcludedList({ colId, pid = null }, args): Promise<any> {
      const { where, sort, ...rest } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const context = baseModel.context;
      const { refContext } = relColOptions.getRelContext();

      const cn = (await relColOptions.getChildColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;
      const refTable = await (await relColOptions.getChildColumn()).getModel();
      const table = await (await relColOptions.getParentColumn()).getModel();
      const refBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: refTable,
      });
      await table.getColumns();

      const childView = await relColOptions.getChildView(refTable);

      const childTn = refBaseModel.getTnPath(refTable);
      const parentTn = baseModel.getTnPath(table);

      const tn = childTn;
      const rtn = parentTn;

      const qb = refBaseModel.dbDriver(tn).where((qb) => {
        qb.whereNotIn(
          cn,
          baseModel
            .dbDriver(rtn)
            .select(rcn)
            // .where(parentTable.primaryKey.cn, pid)
            .where(_wherePk(table.primaryKeys, pid)),
        ).orWhereNull(cn);
      });

      if (+rest?.shuffle) {
        await this.shuffle({ qb });
      }

      // Exclude soft-deleted records from HM excluded list results
      const hmExclListSoftDeleteFilter =
        await refBaseModel.getSoftDeleteFilter();
      if (hmExclListSoftDeleteFilter) qb.where(hmExclListSoftDeleteFilter);

      const hasLimitedAccess = !(await hasTableVisibilityAccess(
        baseModel.context,
        refTable.id,
        context.user,
      ));

      await refBaseModel.selectObject({
        qb,
        pkAndPvOnly: relColOptions.isCrossBaseLink() || hasLimitedAccess,
      });

      const aliasColObjMap = await refTable.getAliasColObjMap();
      const { filters: filterObj } = extractFilterFromXwhere(
        refContext,
        where,
        aliasColObjMap,
      );
      await refBaseModel.getCustomConditionsAndApply({
        column: relColumn,
        view: relColOptions.fk_target_view_id ? childView : null,
        filters: filterObj,
        args,
        qb,
        rowId: pid,
      });

      await refBaseModel.applySortAndFilter({
        table: refTable,
        view: childView,
        qb,
        sort,
        where,
        // condition is applied in getCustomConditionsAndApply and we don't want to apply it again
        onlySort: true,
        prioritizePvSort: true,
      });

      applyPaginate(qb, rest);

      const proto = await refBaseModel.getProto();
      const data = await refBaseModel.execAndParse(
        qb,
        await refTable.getColumns(),
      );
      return await postProcessData(refContext, {
        data: data.map((c) => {
          c.__proto__ = proto;
          return c;
        }),
        model: refTable,
        query: args,
      });
    },

    async getHmChildrenExcludedListCount(
      { colId, pid = null },
      args,
    ): Promise<any> {
      const { where } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );

      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { refContext } = relColOptions.getRelContext();

      const cn = (await relColOptions.getChildColumn()).column_name;
      const rcn = (await relColOptions.getParentColumn()).column_name;
      const refTable = await (await relColOptions.getChildColumn()).getModel();
      const table = await (await relColOptions.getParentColumn()).getModel();

      const refView = await relColOptions.getChildView(refTable);

      const refBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: refTable,
      });

      const childTn = refBaseModel.getTnPath(refTable);
      const parentTn = baseModel.getTnPath(table);

      const tn = childTn;
      const rtn = parentTn;
      await table.getColumns();

      const qb = refBaseModel
        .dbDriver(tn)
        .count(`*`, { as: 'count' })
        .where((qb) => {
          qb.whereNotIn(
            cn,
            baseModel
              .dbDriver(rtn)
              .select(rcn)
              // .where(parentTable.primaryKey.cn, pid)
              .where(_wherePk(table.primaryKeys, pid)),
          ).orWhereNull(cn);
        });

      // Exclude soft-deleted records from HM excluded count results
      const hmExclCountSoftDeleteFilter =
        await refBaseModel.getSoftDeleteFilter();
      if (hmExclCountSoftDeleteFilter) qb.where(hmExclCountSoftDeleteFilter);

      const aliasColObjMap = await refTable.getAliasColObjMap();
      const { filters: filterObj } = extractFilterFromXwhere(
        refBaseModel.context,
        where,
        aliasColObjMap,
      );

      await refBaseModel.getCustomConditionsAndApply({
        column: relColumn,
        view: refView,
        filters: filterObj,
        args,
        qb,
        rowId: pid,
      });

      return (
        await refBaseModel.execAndParse(qb, null, { raw: true, first: true })
      )?.count;
    },

    async getExcludedOneToOneChildrenList(
      { colId, cid = null },
      args,
    ): Promise<any> {
      const { where, sort, ...rest } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { refContext } = relColOptions.getRelContext();

      // one-to-one relation is combination of both hm and bt to identify table which have
      // foreign key column(similar to bt) we are adding a boolean flag `bt` under meta
      const isBt = relColumn.meta?.bt;

      const childContext = isBt ? baseModel.context : refContext;
      const parentContext = isBt ? refContext : baseModel.context;

      const parentCol = await relColOptions.getParentColumn();
      const rcn = parentCol.column_name;
      const parentTable = await parentCol.getModel();

      const childCol = await relColOptions.getChildColumn();
      const cn = childCol.column_name;
      const childTable = await childCol.getModel();

      const parentBaseModel = await Model.getBaseModelSQL(parentContext, {
        dbDriver: baseModel.dbDriver,
        model: parentTable,
      });
      const childBaseModel = await Model.getBaseModelSQL(childContext, {
        dbDriver: baseModel.dbDriver,
        model: childTable,
      });

      const targetView = await relColOptions.getChildView(
        isBt ? parentTable : childTable,
      );
      let listArgs: any = {};
      if (targetView) {
        const { dependencyFields } = await getAst(refContext, {
          model: isBt ? parentTable : childTable,
          query: {},
          view: targetView,
          throwErrorIfInvalidParams: false,
        });
        listArgs = dependencyFields;
      }

      const rtn = parentBaseModel.getTnPath(parentTable);
      const tn = childBaseModel.getTnPath(childTable);
      await childTable.getColumns();
      const refModel = isBt ? parentBaseModel : childBaseModel;

      const qb = refModel.dbDriver(isBt ? rtn : tn).where((qb) => {
        qb.whereNotIn(
          isBt ? rcn : cn,
          baseModel
            .dbDriver(isBt ? tn : rtn)
            .select(isBt ? cn : rcn)
            .where(_wherePk((isBt ? childTable : parentTable).primaryKeys, cid))
            .whereNotNull(isBt ? cn : rcn),
        ).orWhereNull(isBt ? rcn : cn);
      });

      if (+rest?.shuffle) {
        await this.shuffle({ qb });
      }

      // pre-load columns for later user
      await parentTable.getColumns();
      await childTable.getColumns();

      const hasLimitedAccess = !(await hasTableVisibilityAccess(
        baseModel.context,
        (isBt ? parentTable : childTable).id,
        baseModel.context.user,
      ));

      await refModel.selectObject({
        qb,
        fieldsSet: listArgs.fieldsSet,
        viewId: targetView?.id,
        pkAndPvOnly: relColOptions.isCrossBaseLink() || hasLimitedAccess,
      });

      // extract col-alias map based on the correct relation table
      const aliasColObjMap = await (isBt
        ? parentTable
        : childTable
      ).getAliasColObjMap();
      const { filters: filterObj } = extractFilterFromXwhere(
        refModel.context,
        where,
        aliasColObjMap,
      );

      await refModel.getCustomConditionsAndApply({
        column: relColumn,
        view: relColOptions.fk_target_view_id ? targetView : null,
        filters: filterObj,
        args,
        qb,
        rowId: cid,
      });

      await refModel.applySortAndFilter({
        table: isBt ? parentTable : childTable,
        view: targetView,
        qb,
        sort,
        where,
        // condition is applied in getCustomConditionsAndApply and we don't want to apply it again
        onlySort: true,
        prioritizePvSort: true,
      });

      const ooExcludedListSoftDeleteFilter =
        await refModel.getSoftDeleteFilter();
      if (ooExcludedListSoftDeleteFilter)
        qb.where(ooExcludedListSoftDeleteFilter);

      applyPaginate(qb, rest);

      const proto = await refModel.getProto();
      const data = await refModel.execAndParse(
        qb,
        await (isBt ? parentTable : childTable).getColumns(),
      );

      return await postProcessData(refContext, {
        data: data.map((c) => {
          c.__proto__ = proto;
          return c;
        }),
        model: isBt ? parentTable : childTable,
        query: args,
      });
    },

    async getBtChildrenExcludedListCount(
      { colId, cid = null },
      args,
    ): Promise<any> {
      const { where } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { refContext } = relColOptions.getRelContext();

      const rcn = (await relColOptions.getParentColumn()).column_name;
      const parentTable = await (
        await relColOptions.getParentColumn()
      ).getModel();
      const cn = (await relColOptions.getChildColumn()).column_name;
      const childTable = await (
        await relColOptions.getChildColumn()
      ).getModel();

      const parentBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: parentTable,
      });

      const childTn = baseModel.getTnPath(childTable);
      const parentTn = parentBaseModel.getTnPath(parentTable);

      const rtn = parentTn;
      const tn = childTn;
      await childTable.getColumns();

      const qb = parentBaseModel
        .dbDriver(rtn)
        .where((qb) => {
          qb.whereNotIn(
            rcn,
            baseModel
              .dbDriver(tn)
              .select(cn)
              // .where(childTable.primaryKey.cn, cid)
              .where(_wherePk(childTable.primaryKeys, cid))
              .whereNotNull(cn),
          );
        })
        .count(`*`, { as: 'count' });

      const aliasColObjMap = await parentTable.getAliasColObjMap();
      const { filters: filterObj } = extractFilterFromXwhere(
        parentBaseModel.context,
        where,
        aliasColObjMap,
      );

      const targetView = await relColOptions.getChildView(parentTable);

      await parentBaseModel.getCustomConditionsAndApply({
        column: relColumn,
        view: targetView,
        filters: filterObj,
        args,
        qb,
        rowId: cid,
      });

      const btExcludedCountSoftDeleteFilter =
        await parentBaseModel.getSoftDeleteFilter();
      if (btExcludedCountSoftDeleteFilter)
        qb.where(btExcludedCountSoftDeleteFilter);

      return (
        await parentBaseModel.execAndParse(qb, null, { raw: true, first: true })
      )?.count;
    },

    async countExcludedOneToOneChildren(
      { colId, cid = null },
      args,
    ): Promise<any> {
      const { where } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { parentContext, childContext } =
        await relColOptions.getParentChildContext();

      const rcn = (await relColOptions.getParentColumn()).column_name;
      const parentTable = await (
        await relColOptions.getParentColumn()
      ).getModel();
      const cn = (await relColOptions.getChildColumn()).column_name;
      const childTable = await (
        await relColOptions.getChildColumn()
      ).getModel();

      const childView = await relColOptions.getChildView(childTable);
      const parentBaseModel = await Model.getBaseModelSQL(parentContext, {
        dbDriver: baseModel.dbDriver,
        model: parentTable,
      });
      const childBaseModel = await Model.getBaseModelSQL(childContext, {
        dbDriver: baseModel.dbDriver,
        model: childTable,
      });
      const childTn = childBaseModel.getTnPath(childTable);
      const parentTn = parentBaseModel.getTnPath(parentTable);

      const rtn = parentTn;
      const tn = childTn;

      // pre-load columns for later user
      await childTable.getColumns();
      await parentTable.getColumns();

      // one-to-one relation is combination of both hm and bt to identify table which have
      // foreign key column(similar to bt) we are adding a boolean flag `bt` under meta
      const isBt = relColumn.meta?.bt;

      const qb = baseModel
        .dbDriver(isBt ? rtn : tn)
        .where((qb) => {
          qb.whereNotIn(
            isBt ? rcn : cn,
            baseModel
              .dbDriver(isBt ? tn : rtn)
              .select(isBt ? cn : rcn)
              .where(
                _wherePk((isBt ? childTable : parentTable).primaryKeys, cid),
              )
              .whereNotNull(isBt ? cn : rcn),
          ).orWhereNull(isBt ? rcn : cn);
        })
        .count(`*`, { as: 'count' });

      // extract col-alias map based on the correct relation table
      const aliasColObjMap = await (isBt
        ? parentTable
        : childTable
      ).getAliasColObjMap();

      const refContext = isBt ? parentContext : childContext;
      const refBaseModel = isBt ? parentBaseModel : childBaseModel;

      const { filters: filterObj } = extractFilterFromXwhere(
        refContext,
        where,
        aliasColObjMap,
      );

      await refBaseModel.getCustomConditionsAndApply({
        column: relColumn,
        view: childView,
        filters: filterObj,
        args,
        qb,
        rowId: cid,
      });

      const ooExcludedCountSoftDeleteFilter =
        await refBaseModel.getSoftDeleteFilter();
      if (ooExcludedCountSoftDeleteFilter)
        qb.where(ooExcludedCountSoftDeleteFilter);

      return (
        await refBaseModel.execAndParse(qb, null, { raw: true, first: true })
      )?.count;
    },

    async getBtChildrenExcludedList({ colId, cid = null }, args): Promise<any> {
      const { where, sort, ...rest } = baseModel._getListArgs(args as any);
      const relColumn = (await baseModel.model.getColumns()).find(
        (c) => c.id === colId,
      );
      const relColOptions =
        (await relColumn.getColOptions()) as LinkToAnotherRecordColumn;

      const { refContext } = relColOptions.getRelContext();

      const rcn = (await relColOptions.getParentColumn()).column_name;
      const parentTable = await (
        await relColOptions.getParentColumn()
      ).getModel();
      const cn = (await relColOptions.getChildColumn()).column_name;
      const childTable = await (
        await relColOptions.getChildColumn()
      ).getModel();
      const parentBaseModel = await Model.getBaseModelSQL(refContext, {
        dbDriver: baseModel.dbDriver,
        model: parentTable,
      });

      const childTn = baseModel.getTnPath(childTable);
      const parentTn = parentBaseModel.getTnPath(parentTable);

      const rtn = parentTn;
      const tn = childTn;
      await childTable.getColumns();

      const qb = parentBaseModel.dbDriver(rtn).where((qb) => {
        qb.whereNotIn(
          rcn,
          baseModel
            .dbDriver(tn)
            .select(cn)
            // .where(childTable.primaryKey.cn, cid)
            .where(_wherePk(childTable.primaryKeys, cid))
            .whereNotNull(cn),
        );
      });

      if (+rest?.shuffle) {
        await this.shuffle({ qb });
      }

      const hasLimitedAccess = !(await hasTableVisibilityAccess(
        baseModel.context,
        parentTable.id,
        baseModel.context.user,
      ));

      await parentBaseModel.selectObject({
        qb,
        pkAndPvOnly: relColOptions.isCrossBaseLink() || hasLimitedAccess,
      });

      const aliasColObjMap = await parentTable.getAliasColObjMap();
      const { filters: filterObj } = extractFilterFromXwhere(
        parentBaseModel.context,
        where,
        aliasColObjMap,
      );

      const targetView = await relColOptions.getChildView(parentTable);
      await parentBaseModel.getCustomConditionsAndApply({
        column: relColumn,
        view: relColOptions.fk_target_view_id ? targetView : null,
        filters: filterObj,
        args,
        qb,
        rowId: cid,
      });

      await parentBaseModel.applySortAndFilter({
        table: parentTable,
        view: targetView,
        qb,
        sort,
        where,
        // condition is applied in getCustomConditionsAndApply and we don't want to apply it again
        onlySort: true,
        prioritizePvSort: true,
      });

      const btExcludedListSoftDeleteFilter =
        await parentBaseModel.getSoftDeleteFilter();
      if (btExcludedListSoftDeleteFilter)
        qb.where(btExcludedListSoftDeleteFilter);

      applyPaginate(qb, rest);

      const proto = await parentBaseModel.getProto();
      const data = await parentBaseModel.execAndParse(
        qb,
        await parentTable.getColumns(),
      );

      return await postProcessData(refContext, {
        data: data.map((c) => {
          c.__proto__ = proto;
          return c;
        }),
        model: parentTable,
        query: args,
      });
    },
  };
};
