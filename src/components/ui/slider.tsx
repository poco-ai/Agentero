"use client";

import { Slider as SliderPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/core/utils";

function Slider({
	className,
	defaultValue,
	value,
	min = 0,
	max = 100,
	"aria-label": ariaLabel,
	"aria-labelledby": ariaLabelledBy,
	...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
	const values = value ?? defaultValue ?? [min];
	return (
		<SliderPrimitive.Root
			data-slot="slider"
			defaultValue={defaultValue}
			value={value}
			min={min}
			max={max}
			className={cn(
				"relative flex w-full touch-none select-none items-center data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
				className,
			)}
			{...props}
		>
			<SliderPrimitive.Track
				data-slot="slider-track"
				className="relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
			>
				<SliderPrimitive.Range
					data-slot="slider-range"
					className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
				/>
			</SliderPrimitive.Track>
			{Array.from({ length: values.length }, (_, index) => (
				<SliderPrimitive.Thumb
					// biome-ignore lint/suspicious/noArrayIndexKey: Thumb identity follows its fixed position in the range, not its changing value.
					key={index}
					data-slot="slider-thumb"
					aria-label={ariaLabel}
					aria-labelledby={ariaLabelledBy}
					className="block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm transition-[color,box-shadow] hover:ring-4 hover:ring-ring/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
				/>
			))}
		</SliderPrimitive.Root>
	);
}

export { Slider };
