# teleport-web-client

Browser-native TypeScript client for the [Teleport XR](https://github.com/teleportxr/teleport)
streaming protocol. Built on WebSocket signalling, WebRTC data channels,
WebCodecs video decode, WebAudio, WebXR and Three.js.

## Status

| Phase | Scope                                  | State          |
|-------|----------------------------------------|----------------|
| 0     | Bootstrap: Vite, TypeScript, Vitest    | done           |
| 1     | Signalling + WebRTC transport          | done           |
| 2     | Wire format + command/message dispatch | done           |
| 3     | Geometry channel + HTTP asset cache    | stub           |
| 4     | Video (WebCodecs, cubemap unpack)      | stub           |
| 5     | Audio (output + microphone input)      | stub           |
| 6     | Input + WebXR poses                    | stub           |
| 7     | `<teleport-viewer>` Web Component      | placeholder    |

The plan is tracked in [`web_client_plan.md`](../web_client_plan.md) of the
parent `teleport` workspace.

## Develop

```bash
npm install
npm test         # vitest, runs the wire-format round-trip suite
npm run build    # vite library build (esm + umd) and .d.ts emit
npm run dev      # vite dev server, opens examples/minimal/index.html
```

## Embed

Once published, the intended embed surface is a single Web Component:

```html
<script type="module"
  src="https://cdn.example/teleport-web-client.es.js"></script>
<teleport-viewer src="wss://server.example/scene-1" autoconnect>
</teleport-viewer>
```

## Layout

```
src/
  index.ts              — public exports
  client.ts             — TeleportClient (signalling + dispatch)
  component.ts          — <teleport-viewer> Web Component
  transport/
    signaling.ts        — WebSocket signalling
    peer.ts             — RTCPeerConnection + named data channels
  wire/
    types.ts            — protocol enums + ids
    reader.ts           — DataView parser primitives
    writer.ts           — DataView builder primitives
    commands.ts         — server -> client command parsers
    messages.ts         — client -> server message builders
  geometry/decoder.ts   — geometry channel framing (Phase 3)
  video/decoder.ts      — WebCodecs wrapper (Phase 4)
  audio/output.ts       — WebAudio playback (Phase 5)
  input/bind.ts         — input regex binding (Phase 6)
tests/
  wire.*.test.ts        — round-trip tests against C++ packed structs
examples/
  minimal/index.html    — manual connect form
```
