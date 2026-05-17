# Codex In Your Android

Codex In Your Android is a phone-first relay for viewing and driving local Codex projects from Android or a mobile browser.

`中文简介`

这是一个把“手机上的指令”和“电脑本地运行的 Codex 项目”连接起来的轻量中继工具。  
你不需要在手机上跑完整开发环境，只需要：

- 在手机上查看项目列表和消息流
- 选择某个具体项目发送下一步指令
- 跟踪执行进度、排队状态和最终回复
- 在需要时取消未完成工作

它适合“电脑继续开着跑任务，人在外面用手机推进进度”的场景。

`English overview`

This project connects mobile commands to Codex projects running on your local machine.  
Instead of moving the full dev environment to your phone, it gives you a lightweight remote control layer for:

- browsing project lists and message streams
- sending the next instruction to a specific project
- tracking progress, queued work, and final replies
- canceling unfinished work when needed

It is designed for situations where your computer stays online and Codex keeps working locally while you manage progress from your phone.

## How it works

1. A local bridge runs on the same computer as Codex.
2. The bridge registers available projects with the relay server.
3. The relay server stores project state, command queues, and message history.
4. A mobile web app or Android wrapper app connects to the relay.
5. Commands sent from the phone are routed back to the selected local project.
6. Codex replies and progress events are sent back to the phone UI.

## Core features

- Project-scoped command routing
- Mobile-friendly conversation stream
- Background job queue per project
- Cancel unfinished work
- Web/PWA entry point
- Optional Android WebView wrapper
- Local bridge + remote relay deployment model

## Repository layout

- `src/`: relay server and local bridge logic
- `public/`: mobile web UI
- `android-wrapper/`: Android shell app for opening the relay like a native app
- `.env.example`: safe sample configuration
- `Dockerfile` and `docker-compose.example.yml`: container deployment examples

## Quick start

1. Copy `.env.example` to `.env`.
2. Fill in:
   - `PUBLIC_ACCESS_TOKEN`
   - `BRIDGE_SHARED_SECRET`
   - `BRIDGE_PROJECT_ROOTS`
3. Install dependencies:

```bash
npm install
```

4. Start the relay server:

```bash
npm run start
```

5. Start the local bridge on the same machine that runs Codex:

```bash
npm run bridge
```

## Example environment variables

See `.env.example` for a safe template.  
This public repo does **not** include any real VPS address, tunnel key, token, local username, or private project path.

## Privacy note

This prepared public version has been sanitized to remove:

- private VPS connection details
- real access tokens and bridge secrets
- local SSH tunnel key references
- personal usernames and personal Windows paths
- project-specific internal deployment details

## Android wrapper

The Android shell app source lives in `android-wrapper/`.  
It loads the relay URL in a WebView and stores the access token locally on the device after first entry.

## Current limitations

- It does not magically sync native Codex desktop chat history unless the bridge explicitly forwards that information.
- Long-running tasks depend on your local computer and Codex process staying online.
- If you want production-grade remote access, you still need to provide your own VPS, VPN, or reverse proxy setup.
