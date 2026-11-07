import { lazy, useEffect, useState } from "react";

const PlazaView = lazy(() =>
	import("@/components/plaza/plaza-view").then((m) => ({
		default: m.PlazaView,
	})),
);

/** Load on first activation, then retain the page until its Dock tab closes. */
export function PlazaTabView({
	active,
	...props
}: {
	active: boolean;
	path: string;
	className?: string;
}) {
	const [visited, setVisited] = useState(false);
	useEffect(() => {
		if (active) setVisited(true);
	}, [active]);

	// Restored background tabs must not start requests before their first visit.
	// Dockview already keeps this shell mounted and controls its visibility.
	if (!active && !visited) return null;
	return <PlazaView {...props} />;
}
