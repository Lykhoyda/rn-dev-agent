const intrinsicJsonStringify = JSON.stringify;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicArraySort = Array.prototype.sort;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicReflectApply = Reflect.apply;
const IntrinsicObject = Object;
const intrinsicObjectPrototype = Object.prototype;
const IntrinsicWeakSet = WeakSet;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetDelete = WeakSet.prototype.delete;
const intrinsicWeakSetHas = WeakSet.prototype.has;

function quoted(value: string | number): string {
  return intrinsicReflectApply(intrinsicJsonStringify, JSON, [value]) as string;
}

function sortedOwnNames(value: object): string[] {
  const names = intrinsicReflectApply(
    intrinsicObjectGetOwnPropertyNames,
    IntrinsicObject,
    [value],
  ) as string[];
  const enumerable: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    const descriptor = intrinsicReflectApply(
      intrinsicObjectGetOwnPropertyDescriptor,
      IntrinsicObject,
      [value, name],
    ) as PropertyDescriptor | undefined;
    if (descriptor?.enumerable) enumerable.push(name);
  }
  return intrinsicReflectApply(intrinsicArraySort, enumerable, []) as string[];
}

export function canonicalAuthorityJson(value: unknown): string {
  const active = new IntrinsicWeakSet<object>();
  const encode = (candidate: unknown): string => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string') return quoted(candidate);
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate === 'number') {
      return intrinsicNumberIsFinite(candidate) ? quoted(candidate) : 'null';
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_VALUE');
    }
    if (intrinsicReflectApply(intrinsicWeakSetHas, active, [candidate])) {
      throw new TypeError('AUTHORITY_JSON_CYCLE');
    }
    intrinsicReflectApply(intrinsicWeakSetAdd, active, [candidate]);
    try {
      if (intrinsicArrayIsArray(candidate)) {
        let serialized = '[';
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0) serialized += ',';
          const descriptor = intrinsicReflectApply(
            intrinsicObjectGetOwnPropertyDescriptor,
            IntrinsicObject,
            [candidate, String(index)],
          ) as PropertyDescriptor | undefined;
          if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('AUTHORITY_JSON_ACCESSOR');
          }
          serialized += encode(descriptor.value);
        }
        return `${serialized}]`;
      }
      const prototype = intrinsicReflectApply(
        intrinsicObjectGetPrototypeOf,
        IntrinsicObject,
        [candidate],
      );
      if (prototype !== intrinsicObjectPrototype && prototype !== null) {
        throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_OBJECT');
      }
      const names = sortedOwnNames(candidate);
      let serialized = '{';
      for (let index = 0; index < names.length; index += 1) {
        if (index > 0) serialized += ',';
        const name = names[index]!;
        const descriptor = intrinsicReflectApply(
          intrinsicObjectGetOwnPropertyDescriptor,
          IntrinsicObject,
          [candidate, name],
        ) as PropertyDescriptor | undefined;
        if (!descriptor || !('value' in descriptor)) {
          throw new TypeError('AUTHORITY_JSON_ACCESSOR');
        }
        serialized += `${quoted(name)}:${encode(descriptor.value)}`;
      }
      return `${serialized}}`;
    } finally {
      intrinsicReflectApply(intrinsicWeakSetDelete, active, [candidate]);
    }
  };
  return encode(value);
}
