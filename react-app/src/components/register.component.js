import React, { Component } from "react";
import Form from "react-validation/build/form";
import Input from "react-validation/build/input";
import CheckButton from "react-validation/build/button";
import Select from "react-select";
import { isEmail } from "validator";
import { Link } from "react-router-dom";

import emailjs, { init } from "emailjs-com";

import AuthService from "../services/auth.service";
import emailjsConfig from "../config/emailjs.config";
import { SCHOOLS } from "../constants/school-options";
import "../curriculum.css";

const schoolOptions = SCHOOLS.map((s) => ({ value: s.code, label: s.name }));

const jwt = require("jsonwebtoken");

init(emailjsConfig.userId);

const required = (value) => {
  if (!value) {
    return (
      <div className="alert alert-danger" role="alert">
        请填写!
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

const vusername = (value) => {
  if (value.length < 3 || value.length > 20) {
    return (
      <div className="alert alert-danger" role="alert">
        用户名应含3至20个字节
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

// Simplified from shinshin's register.component.js -- this app only has three roles
// (teacher/expert/admin) and no school/donor domain, so the dozens of school-scoped fields
// (schoolId, title, wechat, contactOnly, ...) are dropped. Self-signup is teacher-only
// (enforced server-side too, see verifySignUp.checkOnlyTeacherRole) -- 专家/管理员 accounts
// are created for someone by an existing admin instead -- so there's no role picker here,
// just a school dropdown (migrated from shinshin's `schools` table). On success this
// triggers the verification email (same client-signed-JWT + emailjs-com flow as
// login.component.js) and shows a "请查收邮件完成验证" landing state instead of routing
// straight to /login.
export default class Register extends Component {
  constructor(props) {
    super(props);
    this.handleRegister = this.handleRegister.bind(this);
    this.onChangeUsername = this.onChangeUsername.bind(this);
    this.onChangeChineseName = this.onChangeChineseName.bind(this);
    this.onChangeEmail = this.onChangeEmail.bind(this);
    this.onChangePassword = this.onChangePassword.bind(this);
    this.onChangeSchool = this.onChangeSchool.bind(this);

    this.state = {
      username: "",
      chineseName: "",
      email: "",
      password: "",
      school: null,
      successful: false,
      message: "",
    };
  }

  onChangeUsername(e) {
    this.setState({ username: e.target.value });
  }

  onChangeChineseName(e) {
    this.setState({ chineseName: e.target.value });
  }

  onChangeEmail(e) {
    this.setState({ email: e.target.value });
  }

  onChangePassword(e) {
    this.setState({ password: e.target.value });
  }

  onChangeSchool(option) {
    this.setState({ school: option });
  }

  emailVerification() {
    if (!this.state.email) return;

    const token = jwt.sign({ email: this.state.email }, emailjsConfig.jwtSecret, {
      expiresIn: 60 * 120, // 2小时
    });

    const url = window.location.origin;
    const templateParams = {
      to: this.state.email,
      username: (this.state.chineseName ? this.state.chineseName : this.state.username) + "(登录名: " + this.state.username + ")",
      link: url + "/login?token=" + token,
      validity: "2小时",
    };

    emailjs.send(emailjsConfig.serviceId, emailjsConfig.templateIdEmailVerification, templateParams).then(
      () => {
        this.setState({
          message: "成功创建用户账号，验证邮件已发至您的注册邮箱，请查收邮件完成验证。",
          successful: true,
        });
      },
      (error) => {
        this.setState({
          message: "账号已创建，但验证邮件发送失败：" + (error.text || "请稍后重试或联系管理员。"),
          successful: true,
        });
      }
    );
  }

  handleRegister(e) {
    e.preventDefault();

    this.setState({ message: "", successful: false });

    this.form.validateAll();

    // react-select's Select isn't a react-validation Input, so it's not
    // covered by validateAll() above -- checked separately.
    if (!this.state.school) {
      this.setState({ successful: false, message: "请选择所在学校。" });
      return;
    }

    if (this.checkBtn.context._errors.length === 0) {
      AuthService.signup({
        username: this.state.username,
        email: this.state.email,
        password: this.state.password,
        roles: ["teacher"],
        chineseName: this.state.chineseName,
        schoolCode: this.state.school.value,
      }).then(
        () => {
          this.emailVerification();
        },
        (error) => {
          const resMessage =
            (error.response && error.response.data && error.response.data.message) || error.message || error.toString();

          this.setState({ successful: false, message: resMessage });
        }
      );
    }
  }

  render() {
    return (
      <div className="auth-page">
        {this.state.successful ? (
          <div className="auth-card">
            <div className="auth-badge">
              <i className="fas fa-envelope-open-text"></i>
            </div>
            <h2 className="auth-title">请查收邮件</h2>
            <p className="auth-subtitle">{this.state.message}</p>
            <Link to="/login">
              <button className="auth-btn-primary">前往登录</button>
            </Link>
          </div>
        ) : (
          <div className="auth-card">
            <div className="auth-badge">
              <i className="fas fa-user-plus"></i>
            </div>
            <h2 className="auth-title">创建账号</h2>
            <p className="auth-subtitle">加入乡土课程项目实施与案例分享系统</p>

            <Form
              onSubmit={this.handleRegister}
              ref={(c) => {
                this.form = c;
              }}
            >
              <div className="form-group">
                <label htmlFor="username">
                  用户名<span className="required">*</span>
                </label>
                <Input
                  type="text"
                  className="form-control"
                  name="username"
                  value={this.state.username}
                  onChange={this.onChangeUsername}
                  validations={[required, vusername]}
                />
              </div>

              <div className="form-group">
                <label htmlFor="chineseName">
                  姓名<span className="required">*</span>
                </label>
                <Input
                  type="text"
                  className="form-control"
                  name="chineseName"
                  value={this.state.chineseName}
                  onChange={this.onChangeChineseName}
                  validations={[required]}
                />
              </div>

              <div className="form-group">
                <label htmlFor="email">
                  电子邮箱<span className="required">*</span>
                </label>
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
                <label htmlFor="password">
                  密码<span className="required">*</span>
                </label>
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
                <label htmlFor="school">
                  所在学校<span className="required">*</span>
                </label>
                <Select
                  inputId="school"
                  options={schoolOptions}
                  value={this.state.school}
                  onChange={this.onChangeSchool}
                  placeholder="搜索并选择学校..."
                />
              </div>

              <div className="form-group">
                <button className="auth-btn-primary">注册</button>
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
              已有账号？ <Link to="/login">立即登录</Link>
            </p>
          </div>
        )}
      </div>
    );
  }
}
