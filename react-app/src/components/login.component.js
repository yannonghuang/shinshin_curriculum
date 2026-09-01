import React, { Component } from "react";
import Form from "react-validation/build/form";
import Input from "react-validation/build/input";
import CheckButton from "react-validation/build/button";

import emailjs, { init } from "emailjs-com";
import { Link } from "react-router-dom";

import AuthService from "../services/auth.service";
import emailjsConfig from "../config/emailjs.config";
import "../curriculum.css";

const jwt = require("jsonwebtoken");

init(emailjsConfig.userId);

// 教师 lands on their own plans, 管理员 lands on the full plans list (their
// day-to-day work is managing existing cases, not a generic home dashboard);
// everyone else (专家) keeps the generic home landing.
const landingPathForRoles = (roles) => {
  if ((roles || []).includes("ROLE_TEACHER")) return "/plans?mine=true";
  if ((roles || []).includes("ROLE_ADMIN")) return "/plans";
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

// login.component.js does double duty as login AND forgot-password request, toggled by
// state.isReset (migrated from shinshin's login.component.js, feature-for-feature, jQuery
// password-toggle swapped for a React state flag since this app drops the jquery dependency).
export default class Login extends Component {
  constructor(props) {
    super(props);
    this.handleLogin = this.handleLogin.bind(this);
    this.handleReset = this.handleReset.bind(this);
    this.onChangeUsername = this.onChangeUsername.bind(this);
    this.onChangePassword = this.onChangePassword.bind(this);
    this.onChangeEmail = this.onChangeEmail.bind(this);
    this.onReset = this.onReset.bind(this);
    this.onCancelReset = this.onCancelReset.bind(this);
    this.togglePasswordVisible = this.togglePasswordVisible.bind(this);
    this.resendVerificationEmail = this.resendVerificationEmail.bind(this);

    this.state = {
      username: "",
      password: "",
      email: "",
      isReset: false,
      showPassword: false,
      loading: false,
      message: "",
      unverifiedUser: null,
    };
  }

  componentDidMount() {
    const search = this.props.location.search;
    const username = new URLSearchParams(search).get("username");
    const token = new URLSearchParams(search).get("token");

    if (token) {
      // email-verification link: ?token=<jwt signed with {email}>
      let email = null;
      jwt.verify(token, emailjsConfig.jwtSecret, (err, decoded) => {
        if (!err) email = decoded.email;
      });
      if (email) this.handleEmailVerification(email);
    }

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

  onChangeEmail(e) {
    this.setState({ email: e.target.value });
  }

  onReset() {
    this.setState({ isReset: true, message: "" });
  }

  onCancelReset() {
    this.setState({ isReset: false, message: "" });
  }

  handleEmailVerification(email) {
    AuthService.findByEmail(email, true)
      .then((r) => {
        this.setState({ username: r.data.username });
      })
      .catch((e) => {
        this.setState({ message: e.toString() });
      });
  }

  // Signs a short-lived JWT client-side and emails a verification/reset link via emailjs-com.
  // This mirrors shinshin's login.component.js sendEmail(...) exactly (including the
  // client-side-signed-shared-secret pattern -- see config/emailjs.config.js for the caveat).
  sendEmail(user, message, isReset) {
    this.setState({ loading: true });

    const token = jwt.sign({ email: user.email }, emailjsConfig.jwtSecret, {
      expiresIn: 60 * 120, // 120 minutes
    });

    const url = window.location.origin;

    const templateParams = {
      to: user.email,
      username: (user.chineseName ? user.chineseName : user.username) + "(登录名: " + user.username + ")",
      link: url + "/" + (isReset ? "reset" : "login") + "?token=" + token,
      validity: "2小时",
    };

    const template = isReset ? emailjsConfig.templateIdPasswordReset : emailjsConfig.templateIdEmailVerification;

    emailjs.send(emailjsConfig.serviceId, template, templateParams).then(
      () => {
        this.setState({ message, loading: false });
      },
      (error) => {
        this.setState({ message: error.text || "邮件发送失败。", loading: false });
      }
    );
  }

  resendVerificationEmail() {
    if (!this.state.unverifiedUser) return;
    this.sendEmail(this.state.unverifiedUser, "确认邮件已重新发至您的邮箱，请在2小时内完成确认回执。", false);
  }

  handleReset(e) {
    e.preventDefault();

    this.form.validateAll();
    if (this.checkBtn.context._errors.length > 0) return;

    if (this.state.email) {
      AuthService.findByEmail(this.state.email)
        .then((r) => {
          this.sendEmail(r.data, "邮件已发至您的邮箱，请在2小时内完成密码重置。", true);
        })
        .catch(() => {
          this.setState({ message: "您的注册邮箱地址有误，请提供正确的注册邮箱。" });
        });
    } else {
      this.setState({ message: "请提供注册邮箱。" });
    }
  }

  handleLogin(e) {
    e.preventDefault();

    this.form.validateAll();
    if (this.checkBtn.context._errors.length !== 0) return;

    this.setState({ message: "", loading: true, unverifiedUser: null });

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

        if (error.response && error.response.status === 401 && error.response.data && error.response.data.notEmailVerified) {
          this.setState({
            loading: false,
            message: "您尚未确认邮箱地址，请查收验证邮件后再登录。",
            unverifiedUser: error.response.data,
          });
        } else {
          this.setState({ loading: false, message: resMessage || "登录失败，请确认用户名/密码正确。" });
        }
      }
    );
  }

  render() {
    if (AuthService.isValid()) {
      const currentUser = AuthService.getCurrentUser();
      this.props.history.push(landingPathForRoles(currentUser ? currentUser.roles : []));
      return null;
    }

    const { isReset } = this.state;

    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-badge">
            <i className={isReset ? "fas fa-key" : "fas fa-seedling"}></i>
          </div>
          <h2 className="auth-title">{isReset ? "重置密码" : "欢迎回来"}</h2>
          <p className="auth-subtitle">
            {isReset ? "请提供您的注册邮箱，我们将发送重置链接" : "乡土课程项目实施与案例分享系统"}
          </p>

          <Form
            onSubmit={isReset ? this.handleReset : this.handleLogin}
            ref={(c) => {
              this.form = c;
            }}
          >
            {isReset ? (
              <div className="form-group">
                <label htmlFor="email">您的注册邮箱</label>
                <Input
                  type="text"
                  className="form-control"
                  name="email"
                  value={this.state.email}
                  onChange={this.onChangeEmail}
                  validations={[required]}
                />
              </div>
            ) : (
              <div>
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
                  <button type="button" className="auth-link" onClick={this.onReset}>
                    忘记密码？
                  </button>
                </div>
              </div>
            )}

            <div className="form-group">
              <button className="auth-btn-primary" disabled={this.state.loading}>
                {this.state.loading && <span className="spinner-border spinner-border-sm mr-2"></span>}
                <span>{isReset ? "发送重置邮件" : "登录"}</span>
              </button>
            </div>

            {isReset && (
              <div className="form-group">
                <button type="button" className="btn btn-link btn-block" onClick={this.onCancelReset}>
                  返回登录
                </button>
              </div>
            )}

            {this.state.message && (
              <div className="form-group">
                <div className="auth-alert" role="alert">
                  {this.state.message}
                </div>
              </div>
            )}

            {this.state.unverifiedUser && (
              <div className="form-group">
                <button type="button" className="btn btn-outline-secondary btn-block" onClick={this.resendVerificationEmail}>
                  重新发送验证邮件
                </button>
              </div>
            )}

            <CheckButton
              style={{ display: "none" }}
              ref={(c) => {
                this.checkBtn = c;
              }}
            />
          </Form>

          {!isReset && (
            <p className="auth-footnote">
              还没有账号？ <Link to="/register">立即注册</Link>
            </p>
          )}
        </div>
      </div>
    );
  }
}
