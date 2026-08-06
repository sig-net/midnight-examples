// The browser stand-in for Node's global `Buffer`, imported for its side
// effect at the top of the seed wallet module.
//
// The @midnightntwrk/wallet-sdk-* packages reach for `Buffer` as a bare
// global (keystore address encoding, bech32m codecs, hex conversions) without
// importing it, so no bundler alias can satisfy them: the global itself has
// to exist before those calls run. The feross `buffer` package is the
// standard browser implementation, and the `??=` keeps Node's own Buffer in
// charge under vitest, where it already exists.
import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
