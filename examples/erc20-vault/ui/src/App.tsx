import type { JSX } from "react";
import { BrowserRouter, Route, Routes } from "react-router";

import { AppLayout } from "./components/AppLayout";
import {
  EVMChainConfigProvider,
  MidnightChainConfigProvider,
  MidnightWalletProvider,
} from "./components/contexts";
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
  <MidnightChainConfigProvider>
    <MidnightWalletProvider>
      <EVMChainConfigProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path={RoutePath.Home} element={<HomePage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </EVMChainConfigProvider>
    </MidnightWalletProvider>
  </MidnightChainConfigProvider>
);
