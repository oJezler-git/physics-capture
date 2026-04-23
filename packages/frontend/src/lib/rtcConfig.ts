const splitUrls = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

export const getRtcConfiguration = (): RTCConfiguration => {
  const iceServers: RTCIceServer[] = [];

  const stunUrlsRaw = (import.meta.env.VITE_STUN_URL || 'stun:stun.l.google.com:19302').trim();
  if (stunUrlsRaw) {
    const urls = splitUrls(stunUrlsRaw);
    if (urls.length) iceServers.push({ urls });
  }

  const turnUrlsRaw = (import.meta.env.VITE_TURN_URL || '').trim();
  if (turnUrlsRaw) {
    const urls = splitUrls(turnUrlsRaw);
    if (urls.length) {
      iceServers.push({
        urls,
        username: import.meta.env.VITE_TURN_USERNAME,
        credential: import.meta.env.VITE_TURN_CREDENTIAL,
      });
    }
  }

  const iceTransportPolicyRaw = (import.meta.env.VITE_ICE_TRANSPORT_POLICY || '').trim();
  const iceTransportPolicy =
    iceTransportPolicyRaw === 'relay' || iceTransportPolicyRaw === 'all'
      ? (iceTransportPolicyRaw as RTCIceTransportPolicy)
      : undefined;

  return iceTransportPolicy ? { iceServers, iceTransportPolicy } : { iceServers };
};

export const toSessionDescriptionInit = (value: any): RTCSessionDescriptionInit => ({
  type: value?.type,
  sdp: value?.sdp,
});

export const toIceCandidateInit = (value: any): RTCIceCandidateInit => ({
  candidate: value?.candidate,
  sdpMid: value?.sdpMid,
  sdpMLineIndex: value?.sdpMLineIndex,
  usernameFragment: value?.usernameFragment,
});

export const describeCandidate = (candidate: RTCIceCandidate) => {
  const match = candidate.candidate.match(/ typ ([a-zA-Z0-9]+)/);
  const typ = match?.[1] ?? 'unknown';
  const protocolMatch = candidate.candidate.match(/ udp | tcp /);
  const transport = protocolMatch ? protocolMatch[0].trim() : '';
  return `${typ}${transport ? `/${transport}` : ''}`;
};
