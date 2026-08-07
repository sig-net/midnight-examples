import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router";

import { AppLayout } from "./components/AppLayout";
import {
  ERC20VaultContextProvider,
  EVMChainConfigProvider,
  EVMWalletProvider,
  MidnightChainConfigProvider,
  MidnightWalletProvider,
  ThemeProvider,
} from "./components/contexts";
import { Toaster } from "./components/ui/sonner";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RoutePath } from "./routes";

/**
 * The application root: the provider stack wrapped around the route table.
 * `main.tsx` mounts this and nothing else.
 *
 * @returns The whole app, ready to render into the `#root` element.
 */
export const App = (): JSX.Element => {
  // One QueryClient per app mount: every chain and vault read is a TanStack
  // Query query or mutation underneath, so the provider sits above them all.
  // Lazy component state rather than module scope: a re-render still cannot
  // swap the cache out, while separate app mounts (each test renders its own)
  // do not share one cache.
  const [queryClient] = useState(() => new QueryClient());

  return (
    // ThemeProvider outermost: the toaster reads the theme, and so may anything
    // added later, so nothing below it should have to ask twice.
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <MidnightChainConfigProvider>
          <MidnightWalletProvider>
            <EVMChainConfigProvider>
              <EVMWalletProvider>
                <ERC20VaultContextProvider>
                  <BrowserRouter>
                    <Routes>
                      <Route element={<AppLayout />}>
                        <Route path={RoutePath.Home} element={<HomePage />} />
                        <Route path="*" element={<NotFoundPage />} />
                      </Route>
                    </Routes>
                  </BrowserRouter>
                  {/* Outside the router: a toast raised by a connect must survive the
                      navigation that a connect can trigger. */}
                  <Toaster position="bottom-right" richColors closeButton />
                </ERC20VaultContextProvider>
              </EVMWalletProvider>
            </EVMChainConfigProvider>
          </MidnightWalletProvider>
        </MidnightChainConfigProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
};
