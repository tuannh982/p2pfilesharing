import { DEFAULT_RELAY } from '../config/iceServers';

// Absent means "use the default", which is the case for a link shared before
// the token grew the field; a token minted since then always carries one.
// `??` rather than `||`: index 0 is Google STUN, which is falsy, and a
// truthiness check would replace it with the default instead of letting
// `resolveRelay` make that call.
//
// No range check here on purpose. This function hands back an index, not a
// server, so it has nothing to resolve: `resolveRelay` already sends an index
// this build lacks, or one naming a server that cannot relay, to the default
// relay, and a second copy of that rule here could only be a weaker one. The
// other question - may this entry be designated at all, which a redirect cannot
// answer - is asked before anything is designated, in `ShareTab.tsx`.
export function chooseRelay(relay: number | null): number {
  return relay ?? DEFAULT_RELAY;
}
