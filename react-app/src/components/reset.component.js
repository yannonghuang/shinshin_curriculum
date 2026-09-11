import React, { Component } from "react";
import Form from "react-validation/build/form";
import Input from "react-validation/build/input";
import CheckButton from "react-validation/build/button";
import { isEmail } from "validator";
import { Link } from "react-router-dom";

import AuthService from "../services/auth.service";
import "../curriculum.css";

const required = (value) => {
  if (!value) {
    return (
      <div className="alert alert-danger" role="alert">
        必须填写!
      </div>
    );
  }
};

const email = (value) => {
  if (!isEmail(value)) {
    return (
      <div className="alert alert-danger" role="alert">
        邮件地址不正确
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

// Route /reset: the user re-enters their registered email along with a new password.
// POST /api/auth/reset (see AuthService.reset) looks the account up by that email and, if
// found, sets the new password -- that lookup *is* the identity check (the submitted email
// must match the one already on file for the account). There is no emailed link/token step.
export default class Reset extends Component {
  constructor(props) {
    super(props);
    this.handleReset = this.handleReset.bind(this);
    this.onChangeEmail = this.onChangeEmail.bind(this);
    this.onChangePasswordVerified = this.onChangePasswordVerified.bind(this);
    this.onChangePassword = this.onChangePassword.bind(this);

    this.state = {
      email: "",
      passwordVerified: "",
      password: "",
      loading: false,
      message: "",
    };
  }

  onChangeEmail(e) {
    this.setState({ email: e.target.value });
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

    if (this.state.passwordVerified !== this.state.password) {
      this.setState({ message: "请再次确认密码。" });
      return;
    }

    this.setState({ loading: true, message: "" });

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
        const status = error.response && error.response.status;
        this.setState({
          loading: false,
          message:
            status === 404
              ? "该邮箱尚未注册，请确认后重试。"
              : (error.response && error.response.data && error.response.data.message) || "密码重置失败，请重试。",
        });
      });
  }

  render() {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-badge">
            <i className="fas fa-lock"></i>
          </div>
          <h2 className="auth-title">重置密码</h2>
          <p className="auth-subtitle">请输入您的注册邮箱和新密码</p>

          <Form
            onSubmit={this.handleReset}
            ref={(c) => {
              this.form = c;
            }}
          >
            <div className="form-group">
              <label htmlFor="email">注册邮箱</label>
              <Input
                type="text"
                className="form-control"
                name="email"
                value={this.state.email}
                onChange={this.onChangeEmail}
                validations={[required, email]}
              />
            </div>

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
              <button className="auth-btn-primary" disabled={this.state.loading}>
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
