import { generateRawKey } from '../crypto/keys';
import { DEFAULT_RELAY } from '../config/iceServers';
import type { SharePayload } from './codec';
import { generateRoomId } from './roomId';

export async function mintSharePayload(relay: number = DEFAULT_RELAY): Promise<SharePayload> {
  return {
    roomId: generateRoomId(),
    key: await generateRawKey(),
    relay,
  };
}
