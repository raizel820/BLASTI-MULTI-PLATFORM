"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-input/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // RTL-SAFE THUMB (Task 39): positioned with LOGICAL insets
          // (start-*), never with translate-x. The old implementation anchored
          // the thumb via flex-start — which sits on the RIGHT in RTL (the
          // app's default Arabic direction) — then slid it with a positive
          // translate-x on checked, throwing the knob 14px OUTSIDE the track.
          // Logical insets flip automatically with direction and clamp the
          // thumb inside the pill in both LTR and RTL.
          "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none absolute top-1/2 start-[2px] size-4 -translate-y-1/2 rounded-full ring-0 transition-all duration-200 data-[state=checked]:start-[14px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
