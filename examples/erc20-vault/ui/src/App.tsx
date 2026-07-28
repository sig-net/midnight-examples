import type { JSX } from "react";
import { BrowserRouter, Route, Routes } from "react-router";

import { AppLayout } from "./components/AppLayout";
import {
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
export const App = (): JSX.Element => (
  // ThemeProvider outermost: the toaster reads the theme, and so may anything
  // added later, so nothing below it should have to ask twice.
  <ThemeProvider>
    <MidnightChainConfigProvider>
      <MidnightWalletProvider>
        <EVMChainConfigProvider>
          <EVMWalletProvider>
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
          </EVMWalletProvider>
        </EVMChainConfigProvider>
      </MidnightWalletProvider>
    </MidnightChainConfigProvider>
  </ThemeProvider>
);
