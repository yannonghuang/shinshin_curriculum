import React from "react";
import ReactDOM from "react-dom";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import "./index.css";
import reportWebVitals from "./reportWebVitals";
import startSessionWatchdog from "./services/session-watchdog";

ReactDOM.render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
  document.getElementById("root")
);

// Started once here (not per-component) so it runs for the lifetime of the
// tab regardless of which page is currently mounted -- see its own comment
// for why a purely request-reactive check (token-renewal-interceptor.js)
// isn't enough on its own.
startSessionWatchdog();

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
reportWebVitals();
