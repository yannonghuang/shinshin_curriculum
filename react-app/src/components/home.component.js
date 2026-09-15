import React from "react";
import { Link, Redirect } from "react-router-dom";
import AuthService from "../services/auth.service";
import "../curriculum.css";

const Home = () => {
  const user = AuthService.getCurrentUser();

  // 教师 lands on their own plans directly, skipping this generic dashboard
  // (covers direct visits to "/", not just the post-login redirect).
  if (AuthService.isTeacher()) {
    return <Redirect to="/plans?mine=true" />;
  }

  return (
    <div className="container pl-page">
      <div className="pl-hero">
        <h4 className="pl-title">乡土智课系统</h4>
        <p className="pl-subtitle">
          教师撰写、实施并分享乡土课程；专家与AI智能体协同点评；管理员维护学习资源库与课程案例库。
        </p>
      </div>

      <div className="pl-card">
        {user ? (
          <p>
            欢迎回来，{user.chineseName || user.username}。
          </p>
        ) : (
          <p>
            请<Link to="/login">登录</Link>或<Link to="/register">注册</Link>后开始使用，或直接浏览下方公开内容。
          </p>
        )}
      </div>

      <div className="row">
        {AuthService.isTeacher() && (
          <div className="col-md-4">
            <div className="pl-card">
              <h6>我的乡土课程</h6>
              <p className="text-muted">撰写课程设计方案、按课时记录实施过程、上传照片与材料、申请专家/AI点评。</p>
              <Link className="btn btn-primary btn-sm" to="/plans?mine=true">
                前往我的乡土课程
              </Link>
            </div>
          </div>
        )}
        {AuthService.isExpert() && (
          <div className="col-md-4">
            <div className="pl-card">
              <h6>待点评案例</h6>
              <p className="text-muted">按 WHY/WHAT/HOW 分模块查看教师提交的课程设计与实施记录并给出点评。</p>
              <Link className="btn btn-primary btn-sm" to="/plans?status=submitted">
                前往待点评案例
              </Link>
            </div>
          </div>
        )}
        <div className="col-md-4">
          <div className="pl-card">
            <h6>学习资源库</h6>
            <p className="text-muted">浏览讲座材料、培训视频等，可按乡土主题与年级筛选。</p>
            <Link className="btn btn-outline-primary btn-sm" to="/materials">
              浏览学习资源库
            </Link>
          </div>
        </div>
        <div className="col-md-4">
          <div className="pl-card">
            <h6>课程案例库</h6>
            <p className="text-muted">无需登录即可浏览的优秀乡土课程案例展示墙。</p>
            <Link className="btn btn-outline-primary btn-sm" to="/gallery">
              查看优秀案例
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
