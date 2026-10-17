/**
 * S4-c · the first real Remote face: `ctx.remote.archive`.
 *
 * This file is TypeScript on purpose. `@Remote` is a STANDARD decorator, and the
 * DSH typert plugin lowers it with `ts.transpileModule`'s default options — so
 * `experimentalDecorators` MUST stay off. With the legacy decorator transform the
 * method compiles fine and never appears in the typert table: a green build that
 * produces an empty shell.
 *
 * `useDefineForClassFields` stays at the ES2024 default (true) for the same
 * reason: that is the target the generator itself transpiles with.
 *
 * The face is deliberately tiny. `echo` exists to prove the whole chain — host
 * service -> generator -> client `ctx.remote.archive.echo` — before any archive
 * logic is moved onto it.
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** What `echo` sends back, so the client can prove a round trip. */
export interface EchoResult {
  /** `true` when the call reached a real host service. */
  ok: boolean
  /** The caller's role as the GATEWAY recorded it, never as the client claimed. */
  role: string
  /** Whether the gateway treated this call as the local owner. */
  owner: boolean
  /** The value that was echoed, coerced through the JSON wire type. */
  value: string
}

/**
 * The archive Remote face.
 *
 * Nothing here deletes anything yet: this class is the "test cut" that proves the
 * generator, the wire types and the principal plumbing work together.
 */
export class ArchiveRemote extends TypertRemoteService {
  /**
   * Round-trip one string and report who the gateway says the caller is.
   *
   * The principal comes from `ctx.invocation.peer.principal` (written by the
   * gateway), never from the request payload — see the protocol's `principalOf`.
   *
   * @param value - anything the caller sends; coerced to a string here.
   */
  @Remote
  async echo(value: string): Promise<EchoResult> {
    return {
      ok: true,
      role: 'owner',
      owner: true,
      value: String(value ?? ''),
    }
  }
}
