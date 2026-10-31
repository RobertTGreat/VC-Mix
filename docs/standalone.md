# Standalone receiver

The OBS plugin is the recommended way to use VC Mix. The standalone CLI is available for development and routing participants to separate Windows audio devices.

## Setup

Install Node.js 22.12+ and Python 3.11+, then run:

```powershell
npm run setup
npm run configure
npm start -- --meters-only
```

Configuration prompts hide the bot token and save it in an ignored local `.env` file. `routes.json` stores device assignments and is also ignored. Use `.env.example` and `routes.example.json` as templates.

## Audio devices

Install one independent virtual audio cable per isolated participant. Run `npm run devices` and configure the corresponding WASAPI playback endpoints in `routes.json` or `npm run configure`. For VB-CABLE, route to **CABLE Input** and capture **CABLE Output** in OBS.

```powershell
npm run devices
npm run route -- USER_ID DEVICE_ID
npm start
```

Stop the receiver before changing routes. Participants receive exclusive device assignments; an exhausted device pool leaves additional participants unrouted. Missing devices produce an error instead of falling back to the default speakers.

Stop the standalone receiver before using the OBS plugin with the same bot in the same server.
