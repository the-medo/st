import sheepIcon from '../assets/brand/sheep.png';
import type { ComponentProps } from "react";

export function OvisMark({ className, ...rest }: ComponentProps<"img">) {
  return <img src={sheepIcon} alt="" {...rest} className={`ovis-mark${className ? ` ${className}` : ""}`} />;
}
