// NetInfo adapter (thin, untested): online = connected and the internet is not known to be unreachable.
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

export const isOnline = (s: NetInfoState): boolean => s.isConnected === true && s.isInternetReachable !== false;

export function watchConnectivity(onChange: (online: boolean) => void): () => void {
  return NetInfo.addEventListener((s) => onChange(isOnline(s)));
}

export async function currentlyOnline(): Promise<boolean> {
  return isOnline(await NetInfo.fetch());
}
