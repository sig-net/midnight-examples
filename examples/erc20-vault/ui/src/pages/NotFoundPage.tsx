import type { JSX } from "react";
import { Link } from "react-router";

import { RoutePath } from "../routes";

/**
 * The catch-all view for a path no route in {@link RoutePath} matches.
 *
 * @returns The not-found view, with a way back to the overview.
 */
export const NotFoundPage = (): JSX.Element => (
  <section className="flex flex-col items-start gap-4">
    <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
    <p className="text-muted-foreground">That path is not part of this app.</p>
    <Link to={RoutePath.Home} className="font-medium text-primary underline underline-offset-4">
      Back to overview
    </Link>
  </section>
);
