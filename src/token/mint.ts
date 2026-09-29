import { generateRawKey } from '../crypto/keys';
import type { SharePayload } from './codec';
import { generateRoomId } from './roomId';

export async function mintSharePayload(): Promise<SharePayload> {
  return {
    roomId: generateRoomId(),
    key: await generateRawKey(),
  };
}
