import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	OctagonXIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			position="top-right"
			closeButton
			richColors
			expand={false}
			visibleToasts={5}
			// Sit below the custom title bar (~2.5rem) so toasts don't cover traffic lights / tabs.
			offset={{ top: "2.75rem", right: "0.75rem" }}
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				error: <OctagonXIcon className="size-4" />,
				loading: <Loader2Icon className="size-4 animate-spin" />,
			}}
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "calc(var(--radius) + 4px)",
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast: "cn-toast shadow-overlay",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
