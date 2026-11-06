import React from "react";
import { Link } from "react-router-dom";

import { ProjectFolderDataService, ProjectArtifactDataService } from "../services/project.service";
import AuthService from "../services/auth.service";
import LessonFileManager from "./lesson-file-manager.component";
import "../curriculum.css";
import { tr } from "../i18n";

// 项目管理 -- a cloud file repository for admins' documents: one app-wide
// file space in lesson-file-manager.component.js's cloud file system,
// organized however admins like with folders. Admin/super only, enforced
// server-side on every route (download included -- see project.routes.js).
const ProjectManagement = () => {
  if (!AuthService.isAdmin()) {
    return (
      <div className="container pl-page">
        <div className="pl-empty">
          {AuthService.isLogin() ? (
            tr("仅管理员可以访问项目管理。")
          ) : (
            <>
              {tr("请先")}
              <Link to="/login">{tr("登录")}</Link>
              {tr("。")}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="container pl-page">
      <div className="pl-hero">
        <h4 className="pl-title">{tr("项目管理")}</h4>
        <p className="pl-subtitle mb-0">{tr("管理员的文档云盘：用文件夹自由组织、存放和下载文件。")}</p>
      </div>
      <LessonFileManager
        planId={null}
        lessonIndex={null}
        canEdit
        canDownload
        folderService={ProjectFolderDataService}
        artifactService={ProjectArtifactDataService}
        docCategoryLabel="Word文档"
        downloadUrlBase="/api/project-artifacts"
        downloadRequiresAuth
      />
    </div>
  );
};

export default ProjectManagement;
