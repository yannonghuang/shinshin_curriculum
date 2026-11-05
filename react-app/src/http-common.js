import axios from "axios";
// Before axios.create() below: sets the X-Lang default it copies.
import "./i18n";
import attachTokenRenewalInterceptor from "./services/token-renewal-interceptor";

const instance = axios.create({
  baseURL: "/api",
  headers: {
    "Content-type": "application/json",
  },
});

attachTokenRenewalInterceptor(instance);

export default instance;
