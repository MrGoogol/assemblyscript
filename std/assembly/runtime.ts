// The runtime provides common functionality that links runtime interfaces for memory management
// and garbage collection to the standard library, making sure it all plays well together.

import { AL_MASK, MAX_SIZE_32 } from "./util/allocator";
import { HEAP_BASE, memory } from "./memory";
import { ArrayBufferView } from "./arraybuffer";

/**
 * The common runtime object header prepended to all managed objects. Has a size of 16 bytes in
 * WASM32 and contains a classId (e.g. for instanceof checks), the allocation size (e.g. for
 * .byteLength and .length computation) and additional reserved fields to be used by GC. If no
 * GC is present, the HEADER is cut into half excluding the reserved fields, as indicated by
 * HEADER_SIZE.
*/
@unmanaged export class HEADER {
  /** Unique id of the respective class or a magic value if not yet registered.*/
  classId: u32;
  /** Size of the allocated payload. */
  payloadSize: u32;
  /** Reserved field for use by GC. Only present if GC is. */
  reserved1: usize; // itcm: tagged next
  /** Reserved field for use by GC. Only present if GC is. */
  reserved2: usize; // itcm: prev
}

/** Common runtime header size. */
// @ts-ignore: decorator
@lazy
export const HEADER_SIZE: usize = isDefined(__ref_collect)
  ? (offsetof<HEADER>(           ) + AL_MASK) & ~AL_MASK  // full header if GC is present
  : (offsetof<HEADER>("reserved1") + AL_MASK) & ~AL_MASK; // half header if GC is absent

/** Common runtime header magic. Used to assert registered/unregistered status. */
// @ts-ignore: decorator
@lazy
export const HEADER_MAGIC: u32 = 0xA55E4B17;

/** Gets the computed unique class id of a class type. */
// @ts-ignore: decorator
@unsafe @builtin
export declare function classId<T>(): u32;

/** Iterates over all root objects of a reference type. */
// @ts-ignore: decorator
@unsafe @builtin
export declare function iterateRoots(fn: (ref: usize) => void): void;

/** Runtime implementation. */
export namespace runtime {

  /** Maximum byte length of any buffer-like object. */
  // @ts-ignore
  @lazy
  export const MAX_BYTELENGTH: i32 = MAX_SIZE_32 - HEADER_SIZE;

  /** Adjusts an allocation to actual block size. Primarily targets TLSF. */
  export function adjust(payloadSize: usize): usize {
    // round up to power of 2, e.g. with HEADER_SIZE=8:
    // 0            -> 2^3  = 8
    // 1..8         -> 2^4  = 16
    // 9..24        -> 2^5  = 32
    // ...
    // MAX_LENGTH   -> 2^30 = 0x40000000 (MAX_SIZE_32)
    return <usize>1 << <usize>(<u32>32 - clz<u32>(payloadSize + HEADER_SIZE - 1));
  }

  // @ts-ignore: decorator
  @unsafe
  export function allocate(payloadSize: usize): usize {
    var header = changetype<HEADER>(memory.allocate(adjust(payloadSize)));
    header.classId = HEADER_MAGIC;
    header.payloadSize = payloadSize;
    if (isDefined(__ref_collect)) {
      header.reserved1 = 0;
      header.reserved2 = 0;
    }
    return changetype<usize>(header) + HEADER_SIZE;
  }

  // @ts-ignore: decorator
  @unsafe
  export function reallocate(ref: usize, newPayloadSize: usize): usize {
    // Background: When managed objects are allocated these aren't immediately registered with GC
    // but can be used as scratch objects while unregistered. This is useful in situations where
    // the object must be reallocated multiple times because its final size isn't known beforehand,
    // e.g. in Array#filter, with only the final object making it into GC'ed userland.
    var header = changetype<HEADER>(ref - HEADER_SIZE);
    var payloadSize = header.payloadSize;
    if (payloadSize < newPayloadSize) {
      let newAdjustedSize = adjust(newPayloadSize);
      if (select(adjust(payloadSize), 0, ref > HEAP_BASE) < newAdjustedSize) {
        // move if the allocation isn't large enough or not a heap object
        let newHeader = changetype<HEADER>(memory.allocate(newAdjustedSize));
        newHeader.classId = header.classId;
        if (isDefined(__ref_collect)) {
          newHeader.reserved1 = 0;
          newHeader.reserved2 = 0;
        }
        let newRef = changetype<usize>(newHeader) + HEADER_SIZE;
        memory.copy(newRef, ref, payloadSize);
        memory.fill(newRef + payloadSize, 0, newPayloadSize - payloadSize);
        if (header.classId == HEADER_MAGIC) {
          // free right away if not registered yet
          assert(ref > HEAP_BASE); // static objects aren't scratch objects
          memory.free(changetype<usize>(header));
        } else if (isDefined(__ref_collect)) {
          // if previously registered, register again
          // @ts-ignore: stub
          __ref_register(ref);
        }
        header = newHeader;
        ref = newRef;
      } else {
        // otherwise just clear additional memory within this block
        memory.fill(ref + payloadSize, 0, newPayloadSize - payloadSize);
      }
    } else {
      // if the size is the same or less, just update the header accordingly.
      // unused space is cleared when grown, so no need to do this here.
    }
    header.payloadSize = newPayloadSize;
    return ref;
  }

  // @ts-ignore: decorator
  @unsafe
  export function discard(ref: usize): void {
    if (!ASC_NO_ASSERT) {
      assert(ref > HEAP_BASE); // must be a heap object
      let header = changetype<HEADER>(ref - HEADER_SIZE);
      assert(header.classId == HEADER_MAGIC);
      memory.free(changetype<usize>(header));
    } else {
      memory.free(changetype<usize>(ref - HEADER_SIZE));
    }
  }

  // @ts-ignore: decorator
  @unsafe
  export function register(ref: usize, classId: u32): usize {
    if (!ASC_NO_ASSERT) {
      assert(ref > HEAP_BASE); // must be a heap object
      let header = changetype<HEADER>(ref - HEADER_SIZE);
      assert(header.classId == HEADER_MAGIC);
      header.classId = classId;
    } else {
      changetype<HEADER>(ref - HEADER_SIZE).classId = classId;
    }
    if (isDefined(__ref_register)) __ref_register(ref);
    return ref;
  }

  // @ts-ignore: decorator
  @unsafe
  export function makeArray(capacity: i32, cid: u32, alignLog2: usize, source: usize = 0): usize {
    var array = runtime.register(runtime.allocate(offsetof<i32[]>()), cid);
    var bufferSize = <usize>capacity << alignLog2;
    var buffer = runtime.register(runtime.allocate(<usize>capacity << alignLog2), classId<ArrayBuffer>());
    changetype<ArrayBufferView>(array).data = changetype<ArrayBuffer>(buffer); // links
    changetype<ArrayBufferView>(array).dataStart = buffer;
    changetype<ArrayBufferView>(array).dataLength = bufferSize;
    store<i32>(changetype<usize>(array), capacity, offsetof<i32[]>("length_"));
    if (source) memory.copy(buffer, source, bufferSize);
    return array;
  }
}
