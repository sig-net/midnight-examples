import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class values through clsx, then resolve Tailwind conflicts with
 * twMerge: what every shadcn/ui component imports for its `className`.
 *
 * @param inputs - The class values to merge, in ascending precedence.
 * @returns The merged class string.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
