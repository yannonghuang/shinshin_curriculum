import axios from "axios";
import attachTokenRenewalInterceptor from "./services/token-renewal-interceptor";

const instance = axios.create({
  baseURL: "/api",
  headers: {
    "Content-type": "application/json",
  },
});

attachTokenRenewalInterceptor(instance);

export default instance;
