import React from "react";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Audio, Video } from "@remotion/media";
import timeline from "../timeline.json";
import {
  Art,
  Back,
  Mark,
  Camera,
  Chrome,
  Heading,
  Label,
  Rise,
  SceneFooter,
  Step,
  WindowBar,
  blue,
  frameStyle,
  gray,
  ice,
  ink,
  mint,
  mono,
  navy,
  pos,
  sans,
  tween,
} from "./design";

type Scene = (typeof timeline)[number];
const product = "Demo workspace  /  Checkout service";
const label = (text: string, color = mint) => (
  <Label color={color}>{text}</Label>
);
const introViews = [
  {
    from: 0,
    title: "Remote terminal sessions",
    location: "Checkout service",
    scene: "terminals",
  },
  {
    from: 182,
    title: "Coding agents in parallel",
    location: "Copilot review",
    scene: "agents",
  },
  {
    from: 280,
    title: "Remote Docker management",
    location: "edge-03  /  Docker",
    scene: "docker",
  },
  {
    from: 327,
    title: "The same workspace in a browser",
    location: "127.0.0.1:47901",
    scene: "browser",
  },
  {
    from: 382,
    title: "Investigating the checkout worker",
    location: "edge-03  /  Worker logs",
    scene: "incident",
  },
] as const;

const introHosts = [
  { host: "build-01", role: "Developer", imageX: 278, imageY: 64, span: 350 },
  { host: "review-02", role: "Reviewer", imageX: 1003, imageY: 64, span: 350 },
  {
    host: "edge-03",
    role: "Logs",
    imageX: 1005,
    imageY: 288,
    span: 350,
  },
];

function Intro() {
  const frame = useCurrentFrame();
  const view = introViews.filter((v) => v.from <= frame).at(-1)!;
  const enter = view.from === 0 ? 1 : tween(frame, view.from, view.from + 9);
  const incident = view.scene === "incident";
  return (
    <>
      <Back ribbon />
      <div
        style={{
          ...pos(78, 62),
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <Mark size={55} color={mint} />
        <Label color="#c8e5ef">Open source · MIT license</Label>
      </div>
      <div style={pos(78, 231, 810)}>
        <Heading size={134}>TermClaw</Heading>
        <Heading size={76} style={{ color: mint, marginTop: 28 }}>
          Manage remote
          <br />
          terminals and
          <br />
          AI coding agents.
        </Heading>
        <div
          style={{
            color: "#d4eaf2",
            fontSize: 33,
            lineHeight: 1.32,
            marginTop: 37,
            maxWidth: 700,
          }}
        >
          Run sessions in parallel across projects and machines.
        </div>
      </div>
      <div
        style={{
          ...pos(920, 151, 925),
          borderTop: "1px solid #6fa4b4",
          paddingTop: 23,
        }}
      >
        <Label color={mint}>
          {" "}
          {incident ? "Demo project" : "TermClaw workspace"}{" "}
        </Label>
        <div
          style={{
            fontSize: 43,
            fontWeight: 570,
            letterSpacing: -1.5,
            marginTop: 10,
          }}
        >
          {view.title}
        </div>
      </div>
      <div
        style={{
          ...pos(920, 286, 925, 530),
          transform: "translateY(" + (1 - enter) * 16 + "px)",
          opacity: 0.4 + 0.6 * enter,
        }}
      >
        {view.scene === "terminals" ? (
          <div style={{ display: "grid", gap: 13 }}>
            {introHosts.map(({ host, role, imageX, imageY, span }, i) => (
              <div
                key={host}
                style={{
                  ...frameStyle,
                  borderRadius: 12,
                  display: "flex",
                  height: 145,
                  background: "#0c293f",
                }}
              >
                <div
                  style={{
                    boxSizing: "border-box",
                    width: 246,
                    padding: "30px 23px",
                    flexShrink: 0,
                    borderRight: "1px solid #41556a",
                  }}
                >
                  <Label color={mint} style={{ fontSize: 16 }}>
                    SSH · {role}
                  </Label>
                  <div style={{ font: "600 33px " + mono, marginTop: 10 }}>
                    {host}
                  </div>
                </div>
                <Camera
                  name="tiles"
                  width={679}
                  height={145}
                  x={imageX}
                  y={imageY + 2 * tween(frame, 18 + 12 * i, 142 + 12 * i)}
                  span={span}
                />
              </div>
            ))}
          </div>
        ) : (
          <div style={frameStyle}>
            <WindowBar
              title={view.scene === "browser" ? "Browser" : "TermClaw"}
              url={view.location}
              web={view.scene === "browser"}
            />
            {view.scene === "agents" && (
              <Camera
                name="chat-diff"
                x={267}
                y={119}
                span={703}
                width={925}
                height={437}
              />
            )}
            {view.scene === "docker" && (
              <Camera
                name="docker-sorted"
                x={268}
                y={36}
                span={1092}
                width={925}
                height={437}
              />
            )}
            {view.scene === "browser" && (
              <Camera
                name="tiles-done"
                x={0}
                y={0}
                span={1360}
                width={925}
                height={333}
              />
            )}
            {incident && (
              <Camera
                name="logs"
                x={0}
                y={0}
                srcWidth={1200}
                span={835}
                width={925}
                height={375}
              />
            )}
          </div>
        )}
      </div>
      <SceneFooter
        left="Desktop app   /   Windows and macOS"
        right={
          incident
            ? "Example incident   /   Checkout retries"
            : "Access   /   Desktop and browser"
        }
      />
    </>
  );
}

function SSH({ n }: { n: number }) {
  const f = useCurrentFrame(),
    zoom = tween(f, 48, 118) * (1 - tween(f, n * 0.69, n * 0.89));
  return (
    <>
      <Back />
      <Chrome title="Remote sessions" />
      <Rise style={pos(76, 134)}>
        <Heading size={80}>Three SSH sessions, side by side.</Heading>
      </Rise>
      <div style={{ ...pos(76, 259, 1768, 693), ...frameStyle }}>
        <WindowBar url="SSH  ·  tmux" />
        <div style={{ height: 642, overflow: "hidden", position: "relative" }}>
          <Camera
            name="tiles-done"
            width={1768}
            height={642}
            span={1360 - 170 * zoom}
            x={185 * zoom}
          />
          {f < 292 && (
            <Video
              muted
              src={staticFile("ssh-inspect.mp4")}
              style={{
                position: "absolute",
                top: 0,
                left: (-185 * zoom * 1768) / (1360 - 170 * zoom),
                width: (1360 * 1768) / (1360 - 170 * zoom),
              }}
            />
          )}
        </div>
      </div>
      <SceneFooter
        left="build-01  /  developer"
        right="review-02  /  reviewer       edge-03  /  worker logs"
      />
    </>
  );
}
function Web({ n }: { n: number }) {
  const f = useCurrentFrame(),
    t = f / n,
    stage = t < 0.46 ? 0 : t < 0.65 ? 1 : 2;
  return (
    <>
      <Back light />
      <Chrome title="Background mode" light />
      <div style={{ ...pos(76, 228, 632), color: ink }}>
        {label("Desktop → Browser", blue)}
        <Heading size={80} style={{ marginTop: 29 }}>
          Close the
          <br />
          window.
          <br />
          Keep working.
        </Heading>
        <p
          style={{ fontSize: 31, lineHeight: 1.38, color: gray, maxWidth: 570 }}
        >
          The host keeps its sessions running in the background.
        </p>
        <div style={{ marginTop: 46 }}>
          {[
            "Enable the background tray",
            "Sign in to the Web UI",
            "Resume the same sessions",
          ].map((s, i) => (
            <Step light index={i} active={stage} key={s}>
              {s}
            </Step>
          ))}
        </div>
      </div>
      <div
        style={{
          ...pos(754, 174, 1090, 740),
          borderRadius: 24,
          background: "linear-gradient(140deg,#133956,#0b6075)",
          overflow: "hidden",
          boxShadow: "0 20px 45px #193f5c29",
        }}
      >
        <div style={{ ...pos(40, 42) }}>
          {label(
            stage === 0 ? "TermClaw settings" : "Browser access",
            "#c1edf3",
          )}
        </div>
        {stage === 0 ? (
          <Art
            name="background.png"
            style={{
              ...pos(140, 120, 810),
              borderRadius: 16,
              boxShadow: "0 20px 30px #02102140",
            }}
          />
        ) : stage === 1 ? (
          <div style={{ ...pos(110, 170, 870), ...frameStyle }}>
            <WindowBar title="Browser" url="127.0.0.1:47901" web />
            <div style={{ padding: "49px 0", background: "#141414" }}>
              <Art name="login.png" style={{ width: 600, margin: "auto" }} />
            </div>
          </div>
        ) : (
          <div style={{ ...pos(40, 134, 1010), ...frameStyle }}>
            <WindowBar title="Browser" url="127.0.0.1:47901" web />
            <Camera
              name="tiles-done"
              width={1010}
              height={467}
              span={1100}
              x={260}
            />
          </div>
        )}
      </div>
      <SceneFooter
        light
        left="Headless startup   /   --headless --web"
        right="Web UI   /   token-protected"
      />
    </>
  );
}
const toolNames = ["list_sessions", "send_to_session", "read_output"];
function Phone({ n }: { n: number }) {
  const f = useCurrentFrame(),
    t = f / n,
    stage = t < 0.36 ? 0 : t < 0.55 ? 1 : 2,
    answer = t > 0.61;
  const ask = "Check the checkout worker. Why is it retrying so fast?";
  return (
    <>
      <Back />
      <Chrome title="Mobile control  /  MCP" />
      <div
        style={{
          ...pos(151, 145, 476, 813),
          border: "4px solid #709cab",
          borderRadius: 67,
          background: "linear-gradient(145deg,#203b50,#071524)",
          boxShadow: "10px 20px 0 #041226,0 30px 55px #00122599",
          padding: "22px 19px",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            position: "relative",
            height: "100%",
            background: "#eef6f8",
            borderRadius: 44,
            overflow: "hidden",
            color: ink,
          }}
        >
          <div
            style={{
              height: 25,
              width: 126,
              borderRadius: 24,
              background: "#102338",
              margin: "13px auto 8px",
            }}
          />
          <div
            style={{
              padding: "22px 23px 20px",
              borderBottom: "1px solid #bfd4db",
            }}
          >
            <Label color={gray} style={{ fontSize: 16 }}>
              Example conversation
            </Label>
            <Heading size={41} style={{ marginTop: 8 }}>
              Claude
            </Heading>
          </div>
          <div
            style={{
              margin: "33px 20px 0 46px",
              padding: 20,
              borderRadius: "20px 20px 2px 20px",
              background: "#c7e9ed",
              fontSize: 28,
              lineHeight: 1.3,
            }}
          >
            {ask.slice(
              0,
              Math.max(1, Math.floor(tween(f, 3, 45) * ask.length)),
            )}
          </div>
          <Rise at={51} style={{ padding: "32px 23px 8px" }}>
            <Label color={blue} style={{ fontSize: 15 }}>
              TermClaw connector
            </Label>
            <div
              style={{
                fontSize: 22,
                color: gray,
                lineHeight: 1.4,
                marginTop: 8,
              }}
            >
              Checking the shared worker session…
            </div>
          </Rise>
          {answer && (
            <Rise
              at={Math.floor(n * 0.61)}
              style={{ padding: "12px 22px", fontSize: 26, lineHeight: 1.34 }}
            >
              <b>The retry delay is zero.</b>
              <br />
              The developer is adding bounded backoff.
            </Rise>
          )}
          <div style={{ ...pos(25, 704, 365, 2), background: "#c6d8df" }} />
        </div>
      </div>
      <div style={pos(775, 180, 1030)}>
        {label("Model Context Protocol")}
        <Heading size={85} style={{ marginTop: 25 }}>
          Direct your agents
          <br />
          from your phone.
        </Heading>
        <div style={{ marginTop: 30, fontSize: 29, color: "#c6e0ed" }}>
          An authorized MCP client can work with shared sessions.
        </div>
        <div style={{ marginTop: 46 }}>
          {toolNames.map((s, i) => (
            <div
              key={s}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 20,
                height: 74,
                borderTop: "1px solid #426074",
                opacity: i <= stage ? 1 : 0.36,
              }}
            >
              <span style={{ color: mint, width: 25, fontSize: 25 }}>
                {i < stage ? "✓" : i === stage ? "→" : "·"}
              </span>
              <span
                style={{
                  fontFamily: mono,
                  color: ice,
                  fontSize: 28,
                  width: 340,
                }}
              >
                {s}
              </span>
              <span style={{ fontSize: 25, color: "#b6d0df" }}>
                {
                  [
                    "Find the shared agent",
                    "Send the investigation",
                    "Read its findings",
                  ][i]
                }
              </span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 25, marginTop: 33, color: mint }}>
          Claude Code · Codex · Other MCP clients
        </div>
      </div>
      <SceneFooter
        left="Illustrated MCP exchange"
        right="Remote clients need a reachable MCP endpoint"
      />
    </>
  );
}

type View = { image: string; x: number; y: number; span: number };
type ToolScene = {
  light?: boolean;
  kicker: string;
  heading: string;
  steps: string[];
  views: View[];
  breaks: number[];
  detail: string;
};
const scenes: Record<string, ToolScene> = {
  install: {
    light: true,
    kicker: "Agent setup",
    heading: "Install on the remote host.",
    steps: [
      "Choose the project",
      "Select an agent installer",
      "Deploy skills and MCP servers",
    ],
    views: [
      { image: "tiles", x: 310, y: 0, span: 1050 },
      { image: "install", x: 1067, y: 244, span: 293 },
      { image: "install", x: 1044, y: 8, span: 316 },
    ],
    breaks: [0.13, 0.67],
    detail: "Agents menu   /   Project machine",
  },
  acp: {
    kicker: "Agent Client Protocol",
    heading: "Review the agent’s next move.",
    steps: [
      "Open a structured chat",
      "Inspect the proposed change",
      "Answer the permission request",
    ],
    views: [
      { image: "chat", x: 258, y: 0, span: 1095 },
      { image: "chat-diff", x: 267, y: 139, span: 690 },
      { image: "permission", x: 0, y: 0, span: 1066 },
    ],
    breaks: [0.32, 0.69],
    detail: "OpenCode   /   GitHub Copilot",
  },
  git: {
    light: true,
    kicker: "Git integration",
    heading: "Review the patch line by line.",
    steps: [
      "Choose repository and branch",
      "Compare the retry policy",
      "Select files for the commit",
    ],
    views: [
      { image: "git", x: 250, y: 0, span: 920 },
      { image: "git", x: 593, y: 77, span: 695 },
      { image: "git-commit", x: 267, y: 494, span: 635 },
    ],
    breaks: [0.28, 0.67],
    detail: "Branch   /   fix/worker-backoff",
  },
  volumes: {
    kicker: "Remote Docker management",
    heading: "Manage containers on edge-03.",
    steps: [
      "Open a container shell",
      "Browse a volume read only",
      "Manage containers in bulk",
    ],
    views: [
      { image: "docker-sorted", x: 732, y: 226, span: 627 },
      { image: "volumes", x: 257, y: 187, span: 1100 },
      { image: "volume-files", x: 260, y: 0, span: 1095 },
      { image: "docker-bulk", x: 255, y: 178, span: 1098 },
    ],
    breaks: [0.22, 0.37, 0.6],
    detail: "Remote Docker Engine   /   edge-03 over SSH",
  },
  monitor: {
    light: true,
    kicker: "Host monitoring",
    heading: "See the Linux host underneath.",
    steps: [
      "Compare CPU and memory",
      "Inspect disk and network I/O",
      "Find the busiest process",
    ],
    views: [
      { image: "monitor", x: 260, y: 32, span: 1095 },
      { image: "processes", x: 260, y: 230, span: 1090 },
      { image: "processes", x: 266, y: 430, span: 900 },
    ],
    breaks: [0.39, 0.66],
    detail: "Linux host   /   edge-03",
  },
};
function Tool({ kind, n }: { kind: string; n: number }) {
  const cfg = scenes[kind],
    f = useCurrentFrame(),
    t = f / n;
  const ix = cfg.breaks.filter((x) => t >= x).length,
    active = kind === "volumes" ? [0, 1, 1, 2][ix] : ix;
  const v = cfg.views[ix],
    since = (t - (ix ? cfg.breaks[ix - 1] : 0)) * n;
  const paper = !!cfg.light,
    foreground = paper ? ink : ice;
  const width = 1128,
    height = 632;
  const zoom = 1 - 0.028 * tween(since, 0, 92);
  const cut = kind === "acp" && ix === 2;
  const installMenu = kind === "install" && ix > 0;
  return (
    <>
      <Back light={paper} />
      <Chrome title={cfg.kicker} light={paper} />
      <div style={{ ...pos(76, 200, 565), color: foreground }}>
        <Label color={paper ? blue : mint}>Checkout service</Label>
        <Rise style={{ marginTop: 29 }}>
          <Heading size={77}>{cfg.heading}</Heading>
        </Rise>
        <div style={{ marginTop: 46 }}>
          {cfg.steps.map((s, i) => (
            <Step index={i} active={active} light={paper} key={s}>
              {s}
            </Step>
          ))}
        </div>
      </div>
      <div
        style={{
          ...pos(691, 174, width, 740),
          border: "1px solid " + (paper ? "#b4cfd9" : "#42657d"),
          background: paper ? "#c9dfe8" : "#10364e",
          borderRadius: 20,
          overflow: "hidden",
        }}
      >
        <WindowBar title="TermClaw" url={cfg.kicker} />
        {cut ? (
          <div style={{ padding: "125px 39px 0" }}>
            {label("Permission request", mint)}
            <Art
              name="permission.png"
              style={{
                width: 1048,
                marginTop: 24,
                border: "1px solid #55788b",
                borderRadius: 8,
              }}
            />
            <div style={{ color: ice, fontSize: 30, marginTop: 32 }}>
              Choose whether the agent may apply the edit.
            </div>
          </div>
        ) : (
          <div style={{ position: "relative", height, overflow: "hidden" }}>
            <Camera
              name={v.image}
              width={width}
              height={height}
              x={v.x + v.span * (1 - zoom) * (installMenu ? 0.95 : 0.25)}
              y={v.y}
              span={v.span * zoom}
            />
            {kind === "monitor" && ix === 0 && f < 115 && (
              <Video
                muted
                src={staticFile("monitor-inspect.mp4")}
                style={{
                  position: "absolute",
                  width: (1360 * width) / v.span,
                  left: (-v.x * width) / v.span,
                  top: (-v.y * width) / v.span,
                }}
              />
            )}
          </div>
        )}
        <div
          style={{
            ...pos(0, 684, width, 56),
            background: paper ? "#d7e8ef" : "#183a50",
            display: "flex",
            alignItems: "center",
            padding: "0 25px",
            fontFamily: mono,
            fontSize: 21,
            color: paper ? ink : "#d0e6ec",
            boxSizing: "border-box",
          }}
        >
          {" "}
          {cfg.detail}
        </div>
      </div>
      <SceneFooter light={paper} left={product} />
    </>
  );
}
function Orchestrator({ n }: { n: number }) {
  const f = useCurrentFrame(),
    stage = f < n * 0.32 ? 0 : f < n * 0.57 ? 1 : 2;
  return (
    <>
      <Back />
      <Chrome title="Orchestrators" />
      <Rise style={pos(76, 138)}>
        <Heading size={81}>Hand the patch to a reviewer.</Heading>
      </Rise>
      <div
        style={{ ...pos(76, 276, 1768), display: "flex", alignItems: "center" }}
      >
        {["Developer", "Orchestrator", "Reviewer"].map((title, i) => (
          <React.Fragment key={title}>
            {i > 0 && (
              <div
                style={{
                  flex: 1,
                  height: 2,
                  background: i <= stage ? mint : "#476b80",
                  position: "relative",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    right: -1,
                    top: -25,
                    fontSize: 38,
                    color: i <= stage ? mint : "#476b80",
                  }}
                >
                  ›
                </span>
              </div>
            )}
            <div
              style={{
                width: 444,
                border: "1px solid " + (stage === i ? mint : "#496f86"),
                borderRadius: 12,
                padding: "25px 29px",
                color: ice,
                background: stage === i ? "#0a5060" : "#103047",
                boxSizing: "border-box",
              }}
            >
              <Label color={mint} style={{ fontSize: 17 }}>
                {
                  [
                    "Watched session",
                    "OpenCode coordinator",
                    "Watched session",
                  ][i]
                }
              </Label>
              <Heading size={49} style={{ marginTop: 8 }}>
                {title}
              </Heading>
              <div style={{ fontSize: 24, color: "#c3dce7", marginTop: 9 }}>
                {
                  [
                    "Backoff patch ready",
                    "Routes the completion event",
                    "Checks the cap and tests",
                  ][i]
                }
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
      <div style={{ ...pos(76, 511, 1768, 410), ...frameStyle }}>
        <WindowBar title="TermClaw" url="Checkout review" />
        <Camera
          name="orch"
          x={264}
          y={0}
          span={1096}
          width={1768}
          height={359}
        />
      </div>
      <SceneFooter
        left="Watched sessions   /   developer + reviewer"
        right="Round limit   /   4"
      />
    </>
  );
}
function DockerConnection() {
  return (
    <div
      style={{
        ...pos(76, 228, 1768, 66),
        display: "flex",
        alignItems: "center",
        gap: 23,
        color: ice,
        background: "#12334c",
        boxSizing: "border-box",
        padding: "0 26px",
        border: "1px solid #42667d",
        borderRadius: 12,
      }}
    >
      <span style={{ fontSize: 27, fontWeight: 600 }}>Your laptop</span>
      <span style={{ fontSize: 23, color: "#b3d4e0" }}>TermClaw</span>
      <span
        style={{
          fontFamily: mono,
          fontSize: 25,
          color: mint,
          margin: "0 20px",
        }}
      >
        ── SSH ──→
      </span>
      <span style={{ fontSize: 27, fontWeight: 650 }}>edge-03</span>
      <span style={{ fontSize: 24, color: "#bfdae6" }}>
        Remote Linux host · Docker Engine
      </span>
    </div>
  );
}

function Docker({ restart = false }: { restart?: boolean }) {
  const frame = useCurrentFrame();
  const inspectFrom = 164;
  const showDashboard = frame < inspectFrom;
  const inClip = frame >= inspectFrom && frame < inspectFrom + 249;
  const logView = tween(frame, inspectFrom + 125, inspectFrom + 148);
  const restarting = frame >= 72 && frame < 144;
  const restarted = frame >= 144;
  const heading = restart
    ? "Restart one container on edge-03."
    : "Manage Docker on a remote machine.";
  return (
    <>
      <Back />
      <Chrome title="Remote Docker management" />
      <Heading size={76} style={pos(76, 129)}>
        {heading}
      </Heading>
      <DockerConnection />
      <div style={{ ...pos(76, 318, 1768, 635), ...frameStyle }}>
        <WindowBar title="Docker" url="edge-03  /  Checkout service" />
        <div
          style={{
            position: "relative",
            height: 584,
            overflow: "hidden",
            background: "#141414",
          }}
        >
          {restart ? (
            <Video
              muted
              src={staticFile("remote-restart.mp4")}
              style={{
                width: 1768,
                display: "block",
                position: "absolute",
                top: -10,
              }}
            />
          ) : (
            <>
              {showDashboard && (
                <Camera
                  name="docker-sorted"
                  x={264}
                  y={36}
                  span={1096}
                  width={1768}
                  height={584}
                />
              )}
              {inClip && (
                <Sequence from={inspectFrom} durationInFrames={249}>
                  <Video
                    muted
                    src={staticFile("docker-inspect.mp4")}
                    style={{
                      position: "absolute",
                      width: 2188 - 358 * logView,
                      top: -75,
                      left: -418 + 384 * logView,
                    }}
                  />
                </Sequence>
              )}
              {!showDashboard && !inClip && (
                <Camera
                  name="logs"
                  width={1768}
                  height={584}
                  span={1150}
                  srcWidth={1200}
                />
              )}
            </>
          )}
        </div>
      </div>
      <SceneFooter
        left={
          restart
            ? restarted
              ? "checkout-worker   /   Running again on edge-03"
              : restarting
                ? "checkout-worker   /   Restart in progress on edge-03"
                : "checkout-worker   /   Running on edge-03"
            : showDashboard
              ? "Project SSH connection   /   docker system dial-stdio"
              : "Inspect remote CPU usage and stream the worker’s logs"
        }
        right={
          restart
            ? "Staged restart   /   API and cache stay up"
            : "Demo host   /   edge-03"
        }
      />
    </>
  );
}

function RemoteFiles() {
  const frame = useCurrentFrame();
  const seconds = frame / 24;
  const step = seconds < 7.4 ? 0 : seconds < 10.2 ? 1 : seconds < 13.5 ? 2 : 3;
  const headings = [
    "Browse the remote machine.",
    "Download the retry report.",
    "Upload the team’s runbook.",
    "Edit and save on the host.",
  ];
  const paths = [
    "edge-03   /   /srv/checkout",
    "edge-03/reports/retry-report.json   →   Downloads",
    "Your computer   →   edge-03/reports/runbook.md",
    "edge-03   /   /srv/checkout/reports/runbook.md",
  ];
  return (
    <>
      <Back light />
      <Chrome light title="Remote file browser" />
      <Heading size={70} style={{ ...pos(76, 126), color: ink }}>
        {headings[step]}
      </Heading>
      <div
        style={{
          ...pos(136, 215, 1648, 742),
          ...frameStyle,
          boxSizing: "border-box",
        }}
      >
        <WindowBar
          title="TermClaw Files"
          url="Checkout service  ·  SSH  ·  edge-03"
        />
        <Video
          muted
          src={staticFile("remote-files.mp4")}
          style={{ width: "100%", display: "block" }}
        />
      </div>
      <SceneFooter
        light
        left={paths[step]}
        right="Browse  ·  Download  ·  Upload  ·  Edit"
      />
    </>
  );
}

const featureGroups = [
  {
    title: "Connect",
    features: [
      ["Local, SSH & WSL terminals", "Developer hosts and Windows PowerShell"],
      ["Persistent tmux sessions", "Reconnect, forward ports and use X11"],
      [
        "Tabs, tiles & project overview",
        "Session status and desktop notifications",
      ],
      [
        "Browser & background mode",
        "Token sign-in, system tray and headless startup",
      ],
    ],
  },
  {
    title: "Coordinate",
    features: [
      [
        "Agent installers & library",
        "Deploy MCP servers, skills and APM packages",
      ],
      ["OpenCode & Copilot via ACP", "Chat, tool calls, diffs and approvals"],
      [
        "MCP access from your phone",
        "Direct shared sessions from a connected client",
      ],
      [
        "Orchestrators & scheduled prompts",
        "Developer–reviewer loops and timed runs",
      ],
    ],
  },
  {
    title: "Work on the host",
    features: [
      ["Remote file browser", "Browse, upload, download, preview and edit"],
      ["Git & code review", "Repositories, branches, diffs, PRs and CI"],
      [
        "Remote Docker management",
        "Control containers, images and volumes over SSH",
      ],
      ["Linux host monitoring", "CPU, memory, disk, network and processes"],
    ],
  },
];

function FeatureChecklist() {
  const frame = useCurrentFrame();
  return (
    <>
      <Back />
      <Chrome title="Feature checklist" />
      <Heading size={83} style={pos(76, 128)}>
        TermClaw at a glance
      </Heading>
      <div
        style={{
          ...pos(76, 279, 1768),
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 44,
        }}
      >
        {featureGroups.map((group, column) => (
          <div key={group.title}>
            <Label
              color={mint}
              style={{ borderBottom: "2px solid #5794a4", paddingBottom: 21 }}
            >
              {group.title}
            </Label>
            {group.features.map(([title, detail], row) => {
              const done = tween(
                frame,
                6 + (column * 4 + row) * 7,
                18 + (column * 4 + row) * 7,
              );
              return (
                <div
                  key={title}
                  style={{
                    height: 116,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                    paddingTop: 20,
                    boxSizing: "border-box",
                    borderBottom: "1px solid #38576e",
                  }}
                >
                  <svg
                    width="30"
                    height="32"
                    viewBox="0 0 30 32"
                    style={{ flexShrink: 0, marginTop: 1 }}
                    aria-hidden="true"
                  >
                    <rect
                      x="1"
                      y="2"
                      width="27"
                      height="27"
                      rx="6"
                      fill={"rgba(67,222,199," + (0.04 + 0.13 * done) + ")"}
                      stroke="#529c9f"
                    />
                    <path
                      d="m7 15 5 5 11-12"
                      fill="none"
                      stroke={mint}
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      pathLength="1"
                      strokeDasharray="1"
                      strokeDashoffset={1 - done}
                    />
                  </svg>
                  <div>
                    <div
                      style={{
                        fontSize: 31,
                        lineHeight: 1.14,
                        fontWeight: 600,
                        letterSpacing: -1.1,
                      }}
                    >
                      {title}
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 23,
                        lineHeight: 1.23,
                        color: "#bad2df",
                      }}
                    >
                      {detail}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div style={{ ...pos(76, 849, 1768), fontSize: 23, color: "#c1d8e3" }}>
        Save commands, use keyboard shortcuts, review the audit log, and export
        or import your configuration.
      </div>
      <div
        style={{
          ...pos(76, 923, 1768),
          paddingTop: 24,
          borderTop: "1px solid #547287",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontSize: 29, fontWeight: 550 }}>
          Windows &amp; macOS{" "}
          <span style={{ color: "#b8d4e0" }}> · Open source · MIT license</span>
        </div>
        <div
          style={{
            color: mint,
            fontSize: 33,
            fontWeight: 650,
            letterSpacing: -0.9,
          }}
        >
          github.com/vogler75/termclaw ↗
        </div>
      </div>
    </>
  );
}

function Shot({ scene }: { scene: Scene }) {
  const f = useCurrentFrame(),
    k = scene.key,
    n = scene.frames;
  const content =
    k === "intro" ? (
      <Intro />
    ) : k === "ssh" ? (
      <SSH n={n} />
    ) : k === "web" ? (
      <Web n={n} />
    ) : k === "phone" ? (
      <Phone n={n} />
    ) : k === "orch" ? (
      <Orchestrator n={n} />
    ) : k === "files" ? (
      <RemoteFiles />
    ) : k === "docker" ? (
      <Docker />
    ) : k === "restart" ? (
      <Docker restart />
    ) : k === "end" ? (
      <FeatureChecklist />
    ) : (
      <Tool kind={k} n={n} />
    );
  return (
    <AbsoluteFill
      style={{
        fontFamily: sans,
        color: ice,
        overflow: "hidden",
        background: navy,
      }}
    >
      {content}
      {k !== "intro" && k !== "end" && (
        <div style={{ ...pos(0, 1074, 1920, 6), background: "#a4c4cf33" }}>
          <div
            style={{
              width: (f / n) * 100 + "%",
              height: 6,
              background:
                k === "files" || k === "web" || scenes[k]?.light ? blue : mint,
            }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
}
export function Film() {
  return (
    <AbsoluteFill>
      <Audio src={staticFile("score.m4a")} />
      {timeline.map((s) => (
        <Sequence
          key={s.key}
          name={s.title}
          from={s.start}
          durationInFrames={s.frames}
        >
          <Shot scene={s} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
