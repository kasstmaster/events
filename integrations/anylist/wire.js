// Protobuf wire helpers preserve unknown item fields during category moves.
export function varint(n) {
  const a = [];
  while (n > 127) {
    a.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  a.push(n);
  return Buffer.from(a);
}
export function bytesField(id, value) {
  const data = Buffer.from(value);
  return Buffer.concat([varint(id * 8 + 2), varint(data.length), data]);
}
export function wireFields(input) {
  const data = Buffer.from(input),
    result = [];
  let pos = 0;
  const read = () => {
    let n = 0,
      m = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= data.length) throw Error("Invalid AnyList response.");
      const b = data[pos++];
      n += (b & 127) * m;
      if (!(b & 128)) return n;
      m *= 128;
    }
    throw Error("Invalid AnyList response.");
  };
  while (pos < data.length) {
    const start = pos,
      key = read(),
      type = key % 8,
      id = Math.floor(key / 8);
    let value;
    if (type === 0) read();
    else if (type === 1) pos += 8;
    else if (type === 5) pos += 4;
    else if (type === 2) {
      const size = read();
      value = data.subarray(pos, pos + size);
      pos += size;
    } else throw Error("Unsupported AnyList response.");
    if (pos > data.length || !id) throw Error("Invalid AnyList response.");
    result.push({ id, type, value, raw: data.subarray(start, pos) });
  }
  return result;
}
export const stringField = (data, id) =>
  wireFields(data)
    .find((f) => f.id === id && f.type === 2)
    ?.value?.toString() || "";
export function listWire(userData, listId) {
  const shopping = wireFields(userData).find((f) => f.id === 1)?.value;
  if (!shopping) throw Error("Missing AnyList book.");
  const fields = wireFields(shopping),
    list = fields.find(
      (f) =>
        [1, 2].includes(f.id) && f.value && stringField(f.value, 1) === listId,
    )?.value,
    response = fields.find(
      (f) => f.id === 6 && f.value && stringField(f.value, 1) === listId,
    )?.value;
  if (!list || !response) throw Error("Missing AnyList book.");
  const items = new Map(
    wireFields(list)
      .filter((f) => f.id === 4)
      .map((f) => [stringField(f.value, 1), f.value]),
  );
  return { list, response, items };
}
