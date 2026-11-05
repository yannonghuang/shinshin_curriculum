import React, { useEffect, useState } from "react";
import { Link, Redirect } from "react-router-dom";
import AuthService from "../services/auth.service";
import { landingPathForRoles } from "../utils/landingPath";
import "../curriculum.css";
import { tr } from "../i18n";

const Home = () => {
  const user = AuthService.getCurrentUser();
  // 教师/专家 land on their own working list directly, skipping this generic
  // dashboard (covers direct visits to "/", not just the post-login
  // redirect) -- an expert's depends on whether they've reviewed anything
  // yet, hence the lookup (see utils/landingPath.js).
  const landsElsewhere = AuthService.isTeacher() || AuthService.isExpert();
  const [landing, setLanding] = useState(null);
  useEffect(() => {
    if (!landsElsewhere) return undefined;
    let cancelled = false;
    landingPathForRoles(user ? user.roles : []).then((path) => !cancelled && setLanding(path));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (landsElsewhere) return landing ? <Redirect to={landing} /> : null;

  return (
    <div className="container pl-page">
      <div className="pl-hero">
        <h4 className="pl-title">{tr("乡土智课系统")}</h4>
        <p className="pl-subtitle">
          {tr("教师撰写、实施并分享乡土课程；专家与AI智能体协同点评；管理员维护学习资源库与课程案例库。")}
        </p>
      </div>

      <div className="pl-card">
        {user ? (
          <p>
            {tr("欢迎回来，")}{user.chineseName || user.username}{tr("。")}
          </p>
        ) : (
          <p>
            {tr("请")}<Link to="/login">{tr("登录")}</Link>{tr("或")}<Link to="/register">{tr("注册")}</Link>{tr("后开始使用，或直接浏览下方公开内容。")}
          </p>
        )}
      </div>

      <div className="row">
        {AuthService.isTeacher() && (
          <div className="col-md-4">
            <div className="pl-card">
              <h6>{tr("我的乡土课程")}</h6>
              <p className="text-muted">{tr("撰写课程设计方案、按课时记录实施过程、上传照片与材料、申请专家/AI点评。")}</p>
              <Link className="btn btn-primary btn-sm" to="/plans?mine=true">
                {tr("前往我的乡土课程")}
              </Link>
            </div>
          </div>
        )}
        {AuthService.isExpert() && (
          <div className="col-md-4">
            <div className="pl-card">
              <h6>{tr("待点评案例")}</h6>
              <p className="text-muted">{tr("按 WHY/WHAT/HOW 分模块查看教师提交的课程设计与实施记录并给出点评。")}</p>
              <Link className="btn btn-primary btn-sm" to="/plans?status=submitted">
                {tr("前往待点评案例")}
              </Link>
            </div>
          </div>
        )}
        <div className="col-md-4">
          <div className="pl-card">
            <h6>{tr("学习资源库")}</h6>
            <p className="text-muted">{tr("浏览讲座材料、培训视频等，可按乡土主题与年级筛选。")}</p>
            <Link className="btn btn-outline-primary btn-sm" to="/materials">
              {tr("浏览学习资源库")}
            </Link>
          </div>
        </div>
        <div className="col-md-4">
          <div className="pl-card">
            <h6>{tr("课程案例库")}</h6>
            <p className="text-muted">{tr("无需登录即可浏览的优秀乡土课程案例展示墙。")}</p>
            <Link className="btn btn-outline-primary btn-sm" to="/gallery">
              {tr("查看优秀案例")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
