/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law | agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES | CONDITIONS OF ANY KIND, either express | implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { debugAssert } from '../util/assert';

const LONG_SIZE = 64;
const BYTE_SIZE = 8;

/**
 * The default size of the buffer. This is arbitrary, but likely larger than
 * most index values so that less copies of the underlying buffer will be made.
 * For large values, a single copy will made to double the buffer length.
 */
const DEFAULT_BUFFER_SIZE = 1024;

/** Converts a JavaScript number to a byte array (using big endian encoding). */
function doubleToLongBits(value: number): Uint8Array {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, value, /* littleEndian= */ false);
  return new Uint8Array(dv.buffer);
}

/**
 * Counts the number of zeros in a byte.
 *
 * Visible for testing.
 */
export function numberOfLeadingZerosInByte(x: number): number {
  debugAssert(x < 256, 'Provided value is not a byte: ' + x);
  if (x === 0) {
    return 8;
  }

  let zeros = 0;
  if (x >> 4 === 0) {
    // Test if the first four bits are zero.
    zeros += 4;
    x = x << 4;
  }
  if (x >> 6 === 0) {
    // Test if the first two (or next two) bits are zero.
    zeros += 2;
    x = x << 2;
  }
  if (x >> 7 === 0) {
    // Test if the remaining bit is zero.
    zeros += 1;
  }
  return zeros;
}

/** Counts the number of leading zeros in the given byte array. */
function numberOfLeadingZeros(bytes: Uint8Array): number {
  debugAssert(
    bytes.length == 8,
    'Can only count leading zeros in 64-bit numbers'
  );
  let leadingZeros = 0;
  for (let i = 0; i < 8; ++i) {
    const zeros = numberOfLeadingZerosInByte(bytes[i] & 0xff);
    leadingZeros += zeros;
    if (zeros !== 8) {
      break;
    }
  }
  return leadingZeros;
}

/**
 * Returns the number of bytes required to store "value". Leading zero bytes
 * are skipped.
 */
function unsignedNumLength(value: Uint8Array): number {
  // This is just the number of bytes for the unsigned representation of the number.
  const numBits = LONG_SIZE - numberOfLeadingZeros(value);
  return Math.ceil(numBits / BYTE_SIZE);
}

/**
 * OrderedCodeWriter is a minimal-allocation implementation of the writing
 * behavior defined by the backend.
 *
 * The code is ported from its Java counterpart.
 */
export class OrderedCodeWriter {
  buffer = new Uint8Array(DEFAULT_BUFFER_SIZE);
  position = 0;

  writeNumberAscending(val: number): void {
    // Values are encoded with a single byte length prefix, followed by the
    // actual value in big-endian format with leading 0 bytes dropped.
    const value = this.toOrderedBits(val);
    const len = unsignedNumLength(value);
    this.ensureAvailable(1 + len);
    this.buffer[this.position++] = len & 0xff; // Write the length
    for (let i = value.length - len; i < value.length; ++i) {
      this.buffer[this.position++] = value[i] & 0xff;
    }
  }

  writeNumberDescending(val: number): void {
    // Values are encoded with a single byte length prefix, followed by the
    // inverted value in big-endian format with leading 0 bytes dropped.
    const value = this.toOrderedBits(val);
    const len = unsignedNumLength(value);
    this.ensureAvailable(1 + len);
    this.buffer[this.position++] = ~(len & 0xff); // Write the length
    for (let i = value.length - len; i < value.length; ++i) {
      this.buffer[this.position++] = ~(value[i] & 0xff);
    }
  }

  /**
   * Encodes `val` into an encoding so that the order matches the IEEE 754
   * floating-point comparison results with the following exceptions:
   *   -0.0 < 0.0
   *   all non-NaN < NaN
   *   NaN = NaN
   */
  private toOrderedBits(val: number): Uint8Array {
    const value = doubleToLongBits(val);
    // Check if the first bit is set. We use a bit mask since value[0] is
    // encoded as a number from 0 to 255.
    const isNegative = (value[0] & 0x80) !== 0;

    // Revert the two complement to get natural ordering
    value[0] ^= isNegative ? 0xff : 0x80;
    for (let i = 1; i < value.length; ++i) {
      value[i] ^= isNegative ? 0xff : 0x00;
    }
    return value;
  }

  /** Resets the buffer such that it is the same as when it was newly constructed.  */
  reset(): void {
    this.position = 0;
  }

  /** Makes a copy of the encoded bytes in this buffer.  */
  encodedBytes(): Uint8Array {
    return this.buffer.slice(0, this.position);
  }

  private ensureAvailable(bytes: number): void {
    const minCapacity = bytes + this.position;
    if (minCapacity <= this.buffer.length) {
      return;
    }
    // Try doubling.
    let newLength = this.buffer.length * 2;
    // Still not big enough? Just allocate the right size.
    if (newLength < minCapacity) {
      newLength = minCapacity;
    }
    // Create the new buffer.
    const newBuffer = new Uint8Array(newLength);
    newBuffer.set(this.buffer); // copy old data
    this.buffer = newBuffer;
  }
}
