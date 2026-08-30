import React, { Component } from "react";
import Form from "react-validation/build/form";
import Input from "react-validation/build/input";
import CheckButton from "react-validation/build/button";
import { Link } from "react-router-dom";

import AuthService from "../services/auth.service";
import emailjsConfig from "../config/emailjs.config";
import "../curriculum.css";

const jwt = require("jsonwebtoken");

const required = (value) => {
  if (!value) {
    return (
      <div className="alert alert-danger" role="alert">
        必须填写!
      </div>
    );
  }
};

const vpassword = (value) => {
  if (value && value.length > 0 && (value.length < 6 || value.length > 40)) {
    return (
      <div className="alert alert-danger" role="alert">
        密码应含6至40个字节
      </div>
    );
  }
};

// Migrated directly from shinshin's reset.component.js -- route /reset, reads ?token= from
// the query string, verifies it client-side to recover the email (same shared-secret caveat
// as login.component.js's sendEmail), then posts the new password to POST /api/auth/reset.
export default class Reset extends Component {
  constructor(props) {
    super(props);
    this.handleReset = this.handleReset.bind(this);
    this.onChangePasswordVerified = this.onChangePasswordVerified.bind(this);
    this.onChangePassword = this.onChangePassword.bind(this);

    this.state = {
      passwordVerified: "",
      password: "",
      email: null,
      loading: false,
      message: "",
    };
  }

  componentDidMount() {
    const search = this.props.location.search;
    const token = new URLSearchParams(search).get("token");

    let email = null;
    jwt.verify(token, emailjsConfig.jwtSecret, (err, decoded) => {
      if (!err) email = decoded.email;
    });

    if (!email) {
      this.setState({
        message: "密码重置请求失效，请到登录页面重新提供注册邮箱。",
        email: null,
      });
    } else {
      this.setState({ email });
    }
  }

  onChangePasswordVerified(e) {
    this.setState({ passwordVerified: e.target.value });
  }

  onChangePassword(e) {
    this.setState({ password: e.target.value });
  }

  handleReset(e) {
    e.preventDefault();

    this.form.validateAll();
    if (this.checkBtn.context._errors.length > 0) return;

    if (!this.state.email) return;

    if (this.state.passwordVerified === this.state.password) {
      AuthService.reset(this.state.email, this.state.password)
        .then((response) => {
          alert("密码已经成功重置");
          if (!AuthService.getCurrentUser()) {
            this.props.history.push("/login?username=" + (response.data ? response.data.username : ""));
            window.location.reload();
          } else {
            this.props.history.goBack();
          }
        })
        .catch((error) => {
          this.setState({
            message:
              (error.response && error.response.data && error.response.data.message) || "密码重置失败，请重试。",
          });
        });
    } else {
      this.setState({ message: "请再次确认密码。" });
    }
  }

  render() {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-badge">
            <i className="fas fa-lock"></i>
          </div>
          <h2 className="auth-title">设置新密码</h2>
          <p className="auth-subtitle">{this.state.email ? `账号邮箱：${this.state.email}` : "验证您的重置链接"}</p>

          <Form
            onSubmit={this.handleReset}
            ref={(c) => {
              this.form = c;
            }}
          >
            <div className="form-group">
              <label htmlFor="password">新密码</label>
              <Input
                type="password"
                className="form-control"
                name="password"
                value={this.state.password}
                onChange={this.onChangePassword}
                validations={[required, vpassword]}
              />
            </div>

            <div className="form-group">
              <label htmlFor="passwordVerified">新密码再确认</label>
              <Input
                type="password"
                className="form-control"
                name="passwordVerified"
                value={this.state.passwordVerified}
                onChange={this.onChangePasswordVerified}
                validations={[required]}
              />
            </div>

            <div className="form-group">
              <button className="auth-btn-primary" disabled={this.state.loading || !this.state.email}>
                {this.state.loading && <span className="spinner-border spinner-border-sm mr-2"></span>}
                <span>提交</span>
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
            <Link to="/login">返回登录</Link>
          </p>
        </div>
      </div>
    );
  }
}
