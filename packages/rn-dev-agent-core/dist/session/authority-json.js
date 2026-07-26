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
function quoted(value) {
    return intrinsicReflectApply(intrinsicJsonStringify, JSON, [value]);
}
function sortedOwnNames(value) {
    const names = intrinsicReflectApply(intrinsicObjectGetOwnPropertyNames, IntrinsicObject, [
        value,
    ]);
    const enumerable = [];
    for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [value, name]);
        if (descriptor?.enumerable)
            enumerable.push(name);
    }
    return intrinsicReflectApply(intrinsicArraySort, enumerable, []);
}
export function canonicalAuthorityJson(value) {
    const active = new IntrinsicWeakSet();
    const encode = (candidate) => {
        if (candidate === null)
            return 'null';
        if (typeof candidate === 'string')
            return quoted(candidate);
        if (typeof candidate === 'boolean')
            return candidate ? 'true' : 'false';
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
                    if (index > 0)
                        serialized += ',';
                    const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [candidate, String(index)]);
                    if (!descriptor || !('value' in descriptor)) {
                        throw new TypeError('AUTHORITY_JSON_ACCESSOR');
                    }
                    serialized += encode(descriptor.value);
                }
                return `${serialized}]`;
            }
            const prototype = intrinsicReflectApply(intrinsicObjectGetPrototypeOf, IntrinsicObject, [
                candidate,
            ]);
            if (prototype !== intrinsicObjectPrototype && prototype !== null) {
                throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_OBJECT');
            }
            const names = sortedOwnNames(candidate);
            let serialized = '{';
            for (let index = 0; index < names.length; index += 1) {
                if (index > 0)
                    serialized += ',';
                const name = names[index];
                const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [candidate, name]);
                if (!descriptor || !('value' in descriptor)) {
                    throw new TypeError('AUTHORITY_JSON_ACCESSOR');
                }
                serialized += `${quoted(name)}:${encode(descriptor.value)}`;
            }
            return `${serialized}}`;
        }
        finally {
            intrinsicReflectApply(intrinsicWeakSetDelete, active, [candidate]);
        }
    };
    return encode(value);
}
