import { BadRequestV2 } from 'nocodb-sdk';
import type { NcContext } from '~/interface/config';

/**
 * Symbol used to store NcContext on model instances.
 * Non-enumerable + Symbol key ensures:
 * - Object.assign / spread / JSON.stringify never copy or expose it
 * - extractProps (whitelist-only) never includes it in DB inserts
 * - No collision with any DB column name
 */
const NC_MODEL_CONTEXT = Symbol.for('nc_model_context');

/**
 * Attach an NcContext to a model instance.
 * The context is stored as a non-enumerable, non-writable Symbol-keyed property.
 * Call this in every static factory method (get, list, read, insert) that returns an instance.
 */
export function setModelContext<T>(instance: T, context: NcContext): T {
  if (instance && context) {
    Object.defineProperty(instance, NC_MODEL_CONTEXT, {
      value: context,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  return instance;
}

/**
 * Retrieve the NcContext previously stored on a model instance via setModelContext.
 * Returns undefined if the instance was not created through a factory method.
 */
export function getModelContext(instance: any): NcContext | undefined {
  return instance?.[NC_MODEL_CONTEXT];
}

/**
 * Throw a 400 BadRequest when a model instance is accessed without context.
 * Using BadRequest (not a plain Error) avoids 5xx alerts — missing context
 * is a programming error, not a server failure.
 */
export function throwMissingContext(modelName: string): never {
  throw new BadRequestV2(`${modelName} instance accessed without context`);
}
