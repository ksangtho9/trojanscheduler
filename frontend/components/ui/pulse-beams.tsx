"use client";

import React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface BeamPath {
  path: string;
  gradientConfig: {
    initial: { x1: string; x2: string; y1: string; y2: string };
    animate: {
      x1: string | string[];
      x2: string | string[];
      y1: string | string[];
      y2: string | string[];
    };
    transition?: {
      duration?: number;
      repeat?: number;
      repeatType?: string;
      ease?: string;
      repeatDelay?: number;
      delay?: number;
    };
  };
  connectionPoints?: Array<{ cx: number; cy: number; r: number }>;
}

interface GradientColors {
  start: string;
  middle: string;
  end: string;
}

interface PulseBeamsProps {
  children?: React.ReactNode;
  className?: string;
  background?: React.ReactNode;
  beams: BeamPath[];
  width?: number;
  height?: number;
  baseColor?: string;
  accentColor?: string;
  gradientColors?: GradientColors;
}

interface SVGsProps {
  beams: BeamPath[];
  width: number;
  height: number;
  baseColor: string;
  accentColor: string;
  gradientColors?: GradientColors;
}

export const PulseBeams = ({
  children,
  className,
  background,
  beams,
  width = 858,
  height = 434,
  baseColor = "#1e293b",
  accentColor = "#334155",
  gradientColors,
}: PulseBeamsProps) => {
  return (
    <div
      className={cn(
        "w-full h-full relative flex items-center justify-center antialiased overflow-hidden",
        className
      )}
    >
      {background}
      <div className="relative z-10">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <SVGs
          beams={beams}
          width={width}
          height={height}
          baseColor={baseColor}
          accentColor={accentColor}
          gradientColors={gradientColors}
        />
      </div>
    </div>
  );
};

const SVGs = ({ beams, width, height, baseColor, accentColor, gradientColors }: SVGsProps) => {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {beams.map((beam, index) => (
        <React.Fragment key={index}>
          <path d={beam.path} stroke={baseColor} strokeWidth="1" />
          <path
            d={beam.path}
            stroke={`url(#grad${index})`}
            strokeWidth="2"
            strokeLinecap="round"
          />
          {beam.connectionPoints?.map((point, pointIndex) => (
            <circle
              key={`${index}-${pointIndex}`}
              cx={point.cx}
              cy={point.cy}
              r={point.r}
              fill={baseColor}
              stroke={accentColor}
            />
          ))}
        </React.Fragment>
      ))}

      <defs>
        {beams.map((beam, index) => (
          // @ts-expect-error – framer-motion supports linearGradient but typedefs may omit it
          <motion.linearGradient
            key={index}
            id={`grad${index}`}
            gradientUnits="userSpaceOnUse"
            initial={beam.gradientConfig.initial}
            animate={beam.gradientConfig.animate}
            transition={beam.gradientConfig.transition}
          >
            <GradientColors colors={gradientColors} />
          {/* @ts-expect-error */}
          </motion.linearGradient>
        ))}
      </defs>
    </svg>
  );
};

const GradientColors = ({
  colors = { start: "#18CCFC", middle: "#6344F5", end: "#AE48FF" },
}: {
  colors?: GradientColors;
}) => (
  <>
    <stop offset="0%"   stopColor={colors.start}  stopOpacity="0" />
    <stop offset="20%"  stopColor={colors.start}  stopOpacity="1" />
    <stop offset="50%"  stopColor={colors.middle} stopOpacity="1" />
    <stop offset="100%" stopColor={colors.end}    stopOpacity="0" />
  </>
);
