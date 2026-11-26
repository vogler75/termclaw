import React, { CSSProperties } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

export const W = 1920,
  H = 1080,
  ink = "#092345",
  navy = "#061a35",
  ice = "#f4fbff",
  mint = "#66f3dd",
  blue = "#037999",
  gray = "#45627a";
export const sans = '"Helvetica Neue", Helvetica, Arial, sans-serif';
export const mono = "Menlo, Consolas, monospace";
export const ease = (v: number) =>
  Easing.bezier(0.22, 0.8, 0.23, 1)(Math.min(1, Math.max(0, v)));
export const tween = (f: number, a: number, b: number) =>
  interpolate(f, [a, b], [0, 1], {
    easing: ease,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
export const pos = (
  left: number,
  top: number,
  width?: number,
  height?: number,
): CSSProperties => ({ position: "absolute", left, top, width, height });
export function Art({
  name,
  style = {},
}: {
  name: string;
  style?: CSSProperties;
}) {
  return <Img src={staticFile(name)} style={{ display: "block", ...style }} />;
}
export function Mark({
  size = 44,
  color = "currentColor",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="24 24 216 210"
      fill={color}
      aria-hidden="true"
    >
      <path
        d="M50 84 L104 128 L50 172"
        fill="none"
        stroke={color}
        strokeWidth="22"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M150 48 C174 98 164 166 124 210 C134 160 138 104 150 48 Z M184 40 C208 94 198 168 156 216 C166 164 171 102 184 40 Z M216 52 C238 100 230 162 192 206 C201 158 205 106 216 52 Z" />
    </svg>
  );
}
export function Brand({ light = false }: { light?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        color: light ? ink : ice,
        fontSize: 33,
        fontWeight: 650,
        letterSpacing: -1.4,
      }}
    >
      <Mark color={light ? blue : mint} />
      TermClaw
    </div>
  );
}
export function Label({
  children,
  color,
  style = {},
}: {
  children: React.ReactNode;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 19,
        fontWeight: 600,
        letterSpacing: 2.1,
        lineHeight: 1.3,
        textTransform: "uppercase",
        color,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
export function Heading({
  children,
  size = 76,
  style = {},
}: {
  children: React.ReactNode;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: sans,
        fontSize: size,
        fontWeight: 580,
        letterSpacing: -size * 0.052,
        lineHeight: 1.04,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
export function Back({
  light = false,
  ribbon = false,
}: {
  light?: boolean;
  ribbon?: boolean;
}) {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: light ? "#e5f1f6" : navy }}>
      <Art
        name={light ? "paper.jpg" : "deep.jpg"}
        style={{ width: W, height: H }}
      />
      {ribbon && (
        <Art
          name="ribbon.png"
          style={{
            ...pos(0, 0, W, H),
            opacity: 0.78,
            transform:
              "translateX(" +
              (-16 + 12 * Math.sin(f / 88)) +
              "px) scale(1.025)",
          }}
        />
      )}
    </AbsoluteFill>
  );
}
export function Chrome({
  title,
  light = false,
}: {
  title: string;
  light?: boolean;
}) {
  return (
    <div
      style={{
        ...pos(76, 43, 1768),
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: "1px solid " + (light ? "#a6bfce" : "#426079"),
        paddingBottom: 21,
      }}
    >
      <Brand light={light} />
      <Label color={light ? gray : "#b8d7e5"}>{title}</Label>
    </div>
  );
}
export function SceneFooter({
  light = false,
  left,
  right,
}: {
  light?: boolean;
  left: string;
  right?: string;
}) {
  return (
    <div
      style={{
        ...pos(76, 1006, 1768),
        color: light ? gray : "#afcbdb",
        fontFamily: mono,
        fontSize: 19,
        display: "flex",
        justifyContent: "space-between",
      }}
    >
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}
export function Rise({
  children,
  at = 0,
  style = {},
}: {
  children: React.ReactNode;
  at?: number;
  style?: CSSProperties;
}) {
  const f = useCurrentFrame(),
    v = tween(f, at, at + 15);
  return (
    <div
      style={{
        ...style,
        opacity: v,
        transform: "translateY(" + (1 - v) * 17 + "px)",
      }}
    >
      {children}
    </div>
  );
}
// Camera coordinates refer to the browser viewport in CSS pixels, independent of its capture density.
export function Camera({
  name,
  x = 0,
  y = 0,
  span = 1360,
  width,
  height,
  srcWidth = 1360,
  style = {},
}: {
  name: string;
  x?: number;
  y?: number;
  span?: number;
  width: number;
  height: number;
  srcWidth?: number;
  style?: CSSProperties;
}) {
  let scale = width / span;
  return (
    <div
      style={{
        width,
        height,
        overflow: "hidden",
        position: "relative",
        background: "#141414",
        ...style,
      }}
    >
      <Art
        name={name + ".png"}
        style={{
          position: "absolute",
          width: srcWidth * scale,
          maxWidth: "none",
          left: -x * scale,
          top: -y * scale,
        }}
      />
    </div>
  );
}
export function WindowBar({
  title = "TermClaw",
  url = "Checkout service",
  web = false,
}: {
  title?: string;
  url?: string;
  web?: boolean;
}) {
  return (
    <div
      style={{
        height: 51,
        display: "flex",
        alignItems: "center",
        gap: 20,
        background: "#172e46",
        padding: "0 25px",
        color: "#dceaf0",
        fontSize: 20,
        fontFamily: mono,
        borderBottom: "1px solid #416075",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", gap: 7 }}>
        {[0, 1, 2].map((v) => (
          <i
            key={v}
            style={{
              width: 9,
              height: 9,
              borderRadius: 20,
              background: ["#71909f", "#598496", "#71c7ca"][v],
            }}
          />
        ))}
      </div>
      <span style={{ fontWeight: 700 }}>{title}</span>
      <span style={{ opacity: 0.68 }}>{web ? " /  " + url : " ·  " + url}</span>
    </div>
  );
}
export const frameStyle: CSSProperties = {
  overflow: "hidden",
  border: "1px solid #52738a",
  borderRadius: 16,
  boxShadow: "0 18px 42px #051a3230",
  background: "#141414",
};
export function Step({
  index,
  active,
  children,
  light = false,
}: {
  index: number;
  active: number;
  children: React.ReactNode;
  light?: boolean;
}) {
  const on = index === active;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        fontSize: 29,
        fontWeight: on ? 650 : 450,
        color: light ? (on ? ink : "#526b80") : on ? ice : "#9bb7c8",
        marginTop: 17,
      }}
    >
      <div
        style={{
          height: on ? 25 : 3,
          width: 5,
          background: on
            ? light
              ? blue
              : mint
            : light
              ? "#91b1bf"
              : "#4d758a",
        }}
      />
      {children}
    </div>
  );
}
