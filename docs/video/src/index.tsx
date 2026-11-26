import React from "react";
import { Composition, registerRoot } from "remotion";
import timeline from "../timeline.json";
import { Film } from "./Film";
const duration = timeline.reduce((total, s) => total + s.frames, 0);
const Root = () => (
  <Composition
    id="TermClaw"
    component={Film}
    width={1920}
    height={1080}
    fps={24}
    durationInFrames={duration}
  />
);
registerRoot(Root);
