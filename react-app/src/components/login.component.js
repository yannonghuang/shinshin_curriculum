import React, { Component } from "react";
import Form from "react-validation/build/form";
import Input from "react-validation/build/input";
import CheckButton from "react-validation/build/button";

import { Link } from "react-router-dom";

import AuthService from "../services/auth.service";
import "../curriculum.css";

// 教师 lands on their own plans, 专家 lands on the 待点评 queue, 管理员/超级管理员
// land on the full plans list -- each role's day-to-day work is managing
// existing cases, not a generic home dashboard.
const landingPathForRoles = (roles) => {
  const r = roles || [];
  if (r.includes("ROLE_TEACHER")) return "/plans?mine=true";
  if (r.includes("ROLE_EXPERT")) return "/plans?status=submitted";
  if (r.includes("ROLE_ADMIN") || r.includes("ROLE_SUPER")) return "/plans";
  return "/";
};

const required = (value) => {
  if (!value) {
    return (
      <div className="alert alert-danger" role="alert">
        必须填写!
      </div>
    );
  }
};

// Forgot-password now lives entirely on /reset (see reset.component.js), which collects the
// account's email directly and matches it server-side -- no emailed link/token step. This
// component is login only.
export default class Login extends Component {
  constructor(props) {
    super(props);
    this.handleLogin = this.handleLogin.bind(this);
    this.onChangeUsername = this.onChangeUsername.bind(this);
    this.onChangePassword = this.onChangePassword.bind(this);
    this.togglePasswordVisible = this.togglePasswordVisible.bind(this);

    this.state = {
      username: "",
      password: "",
      showPassword: false,
      loading: false,
      message: "",
    };
  }

  componentDidMount() {
    const search = this.props.location.search;
    const username = new URLSearchParams(search).get("username");

    if (username) {
      this.setState({ username });
    }
  }

  togglePasswordVisible(e) {
    e.preventDefault();
    this.setState((prev) => ({ showPassword: !prev.showPassword }));
  }

  onChangeUsername(e) {
    this.setState({ username: e.target.value });
  }

  onChangePassword(e) {
    this.setState({ password: e.target.value });
  }

  handleLogin(e) {
    e.preventDefault();

    this.form.validateAll();
    if (this.checkBtn.context._errors.length !== 0) return;

    this.setState({ message: "", loading: true });

    AuthService.signin(this.state.username, this.state.password).then(
      (response) => {
        if (response.data && response.data.accessToken) {
          localStorage.setItem("user", JSON.stringify(response.data));
          this.setState({ loading: false });
          this.props.history.push(landingPathForRoles(response.data.roles));
          window.location.reload();
        } else {
          this.setState({ loading: false, message: "服务器异常，登录失败。" });
        }
      },
      (error) => {
        const resMessage =
          (error.response && error.response.data && error.response.data.message) ||
          error.message ||
          error.toString();

        this.setState({ loading: false, message: resMessage || "登录失败，请确认用户名/密码正确。" });
      }
    );
  }

  render() {
    if (AuthService.isValid()) {
      const currentUser = AuthService.getCurrentUser();
      this.props.history.push(landingPathForRoles(currentUser ? currentUser.roles : []));
      return null;
    }

    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-badge">
            <i className="fas fa-seedling"></i>
          </div>
          <h2 className="auth-title">欢迎回来</h2>
          <p className="auth-subtitle">乡土智课系统</p>

          <Form
            onSubmit={this.handleLogin}
            ref={(c) => {
              this.form = c;
            }}
          >
            <div className="form-group">
              <label htmlFor="username">用户名</label>
              <Input
                type="text"
                className="form-control"
                name="username"
                value={this.state.username}
                onChange={this.onChangeUsername}
                validations={[required]}
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">密码</label>
              <div className="auth-password-wrap">
                <Input
                  type={this.state.showPassword ? "text" : "password"}
                  className="form-control"
                  name="password"
                  id="password"
                  value={this.state.password}
                  onChange={this.onChangePassword}
                  validations={[required]}
                />
                <button type="button" className="auth-password-toggle" onClick={this.togglePasswordVisible}>
                  <i className={this.state.showPassword ? "fas fa-eye" : "fas fa-eye-slash"}></i>
                </button>
              </div>
            </div>

            <div className="auth-link-row">
              <Link className="auth-link" to="/reset">
                忘记密码？
              </Link>
            </div>

            <div className="form-group">
              <button className="auth-btn-primary" disabled={this.state.loading}>
                {this.state.loading && <span className="spinner-border spinner-border-sm mr-2"></span>}
                <span>登录</span>
              </button>
            </div>

            {this.state.message && (
              <div className="form-group">
                <div className="auth-alert" role="alert">
                  {this.state.message}
                </div>
              </div>
            )}

            <CheckButton
              style={{ display: "none" }}
              ref={(c) => {
                this.checkBtn = c;
              }}
            />
          </Form>

          <p className="auth-footnote">
            还没有账号？ <Link to="/register">立即注册</Link>
          </p>
        </div>
      </div>
    );
  }
}
