import React, { Component } from "react";
import { Switch, Route, Link, withRouter } from "react-router-dom";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap/dist/js/bootstrap.min.js";
import "@fortawesome/fontawesome-free/css/all.css";
import "@fortawesome/fontawesome-free/js/all.js";

import "./App.css";

import Home from "./components/home.component";
import Login from "./components/login.component";
import Register from "./components/register.component";
import Reset from "./components/reset.component";
import PlansList from "./components/plans-list.component";
import PlanDetail from "./components/plan-detail.component";
import LearningMaterialsList from "./components/learning-materials-list.component";
import AdminUsersList from "./components/admin-users-list.component";

import AuthService from "./services/auth.service";

// Small role-gated nav + route table (react-router-dom v5 Switch/Route API, matching
// shinshin's react-router-dom ^5.1.2). shinshin's idle-timeout AccessControlService HOC is
// deliberately dropped here -- it wrapped ~30 routes across a much larger school/donor app;
// this app has 8 routes and doesn't need it, so it would only add friction/complexity.
class App extends Component {
  constructor(props) {
    super(props);
    this.logOut = this.logOut.bind(this);
  }

  logOut() {
    AuthService.signout();
    this.props.history.push("/login");
    window.location.reload();
  }

  // /reset is a bare, chrome-free public route (matching shinshin's public-route styling).
  noNavBar() {
    return this.props.location.pathname === "/reset";
  }

  render() {
    const user = AuthService.getCurrentUser();

    return (
      <div>
        {!this.noNavBar() && (
          <nav className="navbar navbar-expand-sm navbar-dark navbar-custom mb-3">
            <Link to="/" className="navbar-brand">
              乡土课程项目实施与案例分享系统
            </Link>

            <button
              className="navbar-toggler"
              type="button"
              data-toggle="collapse"
              data-target="#navbarSupportedContent"
              aria-controls="navbarSupportedContent"
              aria-expanded="false"
              aria-label="Toggle navigation"
            >
              <span className="navbar-toggler-icon"></span>
            </button>

            <div className="collapse navbar-collapse" id="navbarSupportedContent">
              <ul className="navbar-nav mr-auto">
                {AuthService.isTeacher() && (
                  <li className="nav-item">
                    <Link to="/plans?mine=true" className="nav-link">
                      我的乡土课程
                    </Link>
                  </li>
                )}
                {AuthService.isExpert() && (
                  <li className="nav-item">
                    <Link to="/plans?status=submitted" className="nav-link">
                      待点评案例
                    </Link>
                  </li>
                )}
                {AuthService.isAdmin() && (
                  <li className="nav-item">
                    <Link to="/plans" className="nav-link">
                      全部课程计划
                    </Link>
                  </li>
                )}
                {AuthService.isAdmin() && (
                  <li className="nav-item">
                    <Link to="/admin/users" className="nav-link">
                      用户管理
                    </Link>
                  </li>
                )}
                <li className="nav-item">
                  <Link to="/materials" className="nav-link">
                    共享学习材料库
                  </Link>
                </li>
                <li className="nav-item">
                  <Link to="/gallery" className="nav-link">
                    优秀案例展示
                  </Link>
                </li>
              </ul>

              {AuthService.isLogin() ? (
                <ul className="navbar-nav ml-auto">
                  <li className="nav-item">
                    <span className="nav-link">{user.chineseName || user.username}</span>
                  </li>
                  <li className="nav-item">
                    <a href="#!" className="nav-link" onClick={this.logOut}>
                      退出
                    </a>
                  </li>
                </ul>
              ) : (
                <ul className="navbar-nav ml-auto">
                  <li className="nav-item">
                    <Link to="/login" className="nav-link">
                      登录
                    </Link>
                  </li>
                  <li className="nav-item">
                    <Link to="/register" className="nav-link">
                      注册
                    </Link>
                  </li>
                </ul>
              )}
            </div>
          </nav>
        )}

        <div className="container-fluid">
          <Switch>
            <Route exact path="/reset" component={Reset} />
            <Route exact path="/login" component={Login} />
            <Route exact path="/register" component={Register} />
            <Route exact path={["/", "/home"]} component={Home} />
            <Route exact path="/gallery" render={(routeProps) => <PlansList {...routeProps} excellentOnly />} />
            <Route exact path="/materials" component={LearningMaterialsList} />
            <Route exact path="/admin/users" component={AdminUsersList} />
            <Route exact path="/plans" component={PlansList} />
            <Route path="/plans/:id" component={PlanDetail} />
          </Switch>
        </div>
      </div>
    );
  }
}

export default withRouter(App);
