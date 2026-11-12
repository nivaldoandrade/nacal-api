const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const CLUSTER_ID = 0x1f43b675;
const BLOCK_GROUP_ID = 0xa0;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const CLUSTER_TIMECODE_ID = 0xe7;
const SIMPLE_BLOCK_ID = 0xa3;
const BLOCK_ID = 0xa1;

const MASTER_IDS = new Set([SEGMENT_ID, INFO_ID, CLUSTER_ID, BLOCK_GROUP_ID]);
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

type Vint = {
  value: number;
  length: number;
  isUnknown: boolean;
};

function readVint(file: Buffer, offset: number, keepMarker: boolean): Vint | null {
  if (offset >= file.length) {
    return null;
  }

  const firstByte = file[offset];

  if (firstByte === 0) {
    return null;
  }

  const length = Math.clz32(firstByte) - 23;

  if (offset + length > file.length) {
    return null;
  }

  const marker = 0x80 >> (length - 1);
  let value = keepMarker ? firstByte : firstByte & (marker - 1);
  let allOnes = (firstByte & (marker - 1)) === marker - 1;

  for (let index = 1; index < length; index++) {
    const byte = file[offset + index];
    value = value * 256 + byte;
    allOnes = allOnes && byte === 0xff;
  }

  return {
    value,
    length,
    isUnknown: !keepMarker && allOnes,
  };
}

function readUInt(file: Buffer, start: number, size: number): number {
  let value = 0;

  for (let index = 0; index < size; index++) {
    value = value * 256 + file[start + index];
  }

  return value;
}

function readBlockTimecode(file: Buffer, start: number, end: number): number | null {
  const trackNumber = readVint(file, start, false);

  if (!trackNumber) {
    return null;
  }

  const timecodeOffset = start + trackNumber.length;

  if (timecodeOffset + 2 > end) {
    return null;
  }

  return file.readInt16BE(timecodeOffset);
}

export function getWebmDurationSeconds(file: Buffer): number | null {
  let offset = 0;
  let timecodeScale = DEFAULT_TIMECODE_SCALE_NS;
  let clusterTimecode = 0;
  let lastTimecode: number | null = null;

  while (offset < file.length) {
    const id = readVint(file, offset, true);

    if (!id) {
      break;
    }

    const size = readVint(file, offset + id.length, false);

    if (!size) {
      break;
    }

    const dataStart = offset + id.length + size.length;

    if (MASTER_IDS.has(id.value)) {
      offset = dataStart;
      continue;
    }

    if (size.isUnknown) {
      break;
    }

    const dataEnd = Math.min(dataStart + size.value, file.length);

    if (id.value === TIMECODE_SCALE_ID && dataEnd - dataStart === size.value) {
      timecodeScale = readUInt(file, dataStart, size.value);
    }

    if (id.value === CLUSTER_TIMECODE_ID && dataEnd - dataStart === size.value) {
      clusterTimecode = readUInt(file, dataStart, size.value);
    }

    if (id.value === SIMPLE_BLOCK_ID || id.value === BLOCK_ID) {
      const relativeTimecode = readBlockTimecode(file, dataStart, dataEnd);

      if (relativeTimecode !== null) {
        lastTimecode = Math.max(lastTimecode ?? 0, clusterTimecode + relativeTimecode);
      }
    }

    offset = dataStart + size.value;
  }

  if (lastTimecode === null || !timecodeScale) {
    return null;
  }

  return (lastTimecode * timecodeScale) / 1_000_000_000;
}
