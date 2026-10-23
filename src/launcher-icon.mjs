// A small native Windows icon matching the manager's purple hourglass. The
// bitmap is generated locally so installation needs no graphics dependencies.
export function buildManagerIcon() {
  const size = 32;
  const bitmap = Buffer.alloc(40 + size * size * 4 + size * 4);
  bitmap.writeUInt32LE(40, 0);
  bitmap.writeInt32LE(size, 4);
  bitmap.writeInt32LE(size * 2, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  bitmap.writeUInt32LE(size * size * 4, 20);
  const edges = [[10, 8, 22, 8], [10, 24, 22, 24], [11, 8, 11, 11], [21, 8, 21, 11],
    [11, 11, 21, 21], [21, 11, 11, 21], [11, 21, 11, 24], [21, 21, 21, 24]];
  const distance = (x, y, [ax, ay, bx, by]) => {
    const fraction = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - ax - fraction * (bx - ax), y - ay - fraction * (by - ay));
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let filled = 0; let ink = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4; const py = y + (sy + 0.5) / 4;
      const cornerX = Math.max(0, Math.abs(px - 16) - 9); const cornerY = Math.max(0, Math.abs(py - 16) - 9);
      if (Math.hypot(cornerX, cornerY) > 6) continue;
      filled++;
      if (edges.some(edge => distance(px, py, edge) <= 0.9) ||
          (py >= 10 && py <= 13 && Math.abs(px - 16) <= 13 - py) ||
          (py >= 20 && py <= 22 && Math.abs(px - 16) <= py - 19)) ink++;
    }
    const index = 40 + ((size - 1 - y) * size + x) * 4;
    if (filled) {
      const amount = ink / filled;
      bitmap[index] = Math.round(230 * (1 - amount) + 66 * amount);
      bitmap[index + 1] = Math.round(151 * (1 - amount) + 35 * amount);
      bitmap[index + 2] = Math.round(177 * (1 - amount) + 47 * amount);
      bitmap[index + 3] = Math.round(255 * filled / 16);
    }
  }
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header[6] = size; header[7] = size;
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(bitmap.length, 14); header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, bitmap]);
}
