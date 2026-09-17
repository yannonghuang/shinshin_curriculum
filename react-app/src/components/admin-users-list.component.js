import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Pagination from "@material-ui/lab/Pagination";
import Select from "react-select";
import AdminUserDataService from "../services/admin-user.service";
import PlanDataService from "../services/plan.service";
import AuthService from "../services/auth.service";
import { SCHOOLS, findSchoolByCode, schoolFilterOption } from "../constants/school-options";
import "../curriculum.css";

const ROLE_LABELS = { teacher: "教师", expert: "专家", admin: "管理员", super: "超级管理员" };
const schoolOptions = SCHOOLS.map((s) => ({ value: s.code, label: s.name, address: s.address }));

// totalLoginTime arrives from the backend in accumulated seconds (see
// auth.controller.js's signin/signout) -- rendered as the largest couple of
// units that fit, matching how a human would say it ("3小时25分钟", not
// "12300秒" or a raw decimal-hours number).
const formatDuration = (totalSeconds) => {
  if (!totalSeconds) return "0分钟";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
  return `${minutes}分钟`;
};

// Shows each school's address as a muted second line under its name, so an
// admin/super picking from 392 similarly-named schools (many share a
// county/town name) has enough to tell same-named schools apart --
// react-select renders this for both the open dropdown's option rows and
// the collapsed selected value alike.
const formatSchoolOptionLabel = (option) => (
  <div>
    <div>{option.label}</div>
    {option.address && <div style={{ fontSize: "0.85em", color: "#6c757d" }}>{option.address}</div>}
  </div>
);

const emptyForm = {
  username: "",
  chineseName: "",
  email: "",
  phone: "",
  password: "",
  roles: ["admin"],
  school: null,
  emailVerified: true,
};

// Super-only user management: list/search/paginate, create a user with any role
// (including admin/super -- public signup can never do that, see verifySignUp.checkOnlyTeacherRole),
// suspend/unsuspend, and delete. Follows the same functional-component +
// @material-ui/lab Pagination + pl-drawer-* pattern as plans-list.component.js.
const AdminUsersList = () => {
  const currentUserId = () => {
    const user = AuthService.getCurrentUser();
    return user ? String(user.id) : null;
  };

  const [users, setUsers] = useState([]);
  const [message, setMessage] = useState("");
  const [keyword, setKeyword] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [suspendedFilter, setSuspendedFilter] = useState("");
  const [schoolFilter, setSchoolFilter] = useState(null);
  // Code of the school currently shown in the detail popup, or null when
  // closed -- a popup rather than navigating away (see the 学校编号 cell
  // below) so opening it never loses the list's current page/filters/sort.
  const [schoolDetailCode, setSchoolDetailCode] = useState(null);
  // That school's own 乡土课程设计 list, shown under its info in the same
  // popup -- fetched fresh each time schoolDetailCode changes (see the
  // effect below), not derived from `users` (a school can have plans from
  // teachers not on this page's current filtered/paginated slice).
  const [schoolPlans, setSchoolPlans] = useState([]);
  const [schoolPlansLoading, setSchoolPlansLoading] = useState(false);
  const [schoolPlansMessage, setSchoolPlansMessage] = useState("");
  // sortBy: "" (default, newest-first) | "name" | "school" | "lastLogin" |
  // "totalLoginTime"; only one column sorts at a time, matching a typical
  // clickable-column-header table.
  const [sortBy, setSortBy] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalPages, setTotalPages] = useState(0);
  const [totalItems, setTotalItems] = useState(0);

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const retrieveAll = useCallback(async () => {
    try {
      const resp = await AdminUserDataService.getAll({
        page: page - 1,
        size: pageSize,
        keyword: keyword || undefined,
        role: roleFilter || undefined,
        suspended: suspendedFilter || undefined,
        schoolCode: schoolFilter ? schoolFilter.value : undefined,
        sortBy: sortBy || undefined,
        sortOrder: sortBy ? sortOrder : undefined,
      });
      setUsers(resp.data.rows || []);
      setTotalPages(resp.data.totalPages || 0);
      setTotalItems(resp.data.totalItems || 0);
    } catch (e) {
      console.log(e);
      setMessage("加载用户列表失败。");
    }
  }, [page, pageSize, keyword, roleFilter, suspendedFilter, schoolFilter, sortBy, sortOrder]);

  // Clicking a sortable column header: same column toggles asc/desc, a
  // different column starts fresh at asc. Also resets to page 1, since
  // re-sorting while deep in a later page would otherwise show a
  // disorienting, likely out-of-range page of the newly-ordered results.
  const onSortClick = (key) => {
    setSortOrder(sortBy === key && sortOrder === "asc" ? "desc" : "asc");
    setSortBy(key);
    setPage(1);
  };

  const sortIndicator = (key) => (sortBy === key ? (sortOrder === "asc" ? " ▲" : " ▼") : "");

  useEffect(() => {
    retrieveAll();
  }, [retrieveAll]);

  useEffect(() => {
    if (schoolDetailCode == null) {
      setSchoolPlans([]);
      setSchoolPlansMessage("");
      return;
    }
    setSchoolPlansLoading(true);
    setSchoolPlansMessage("");
    PlanDataService.getAll({ schoolCode: schoolDetailCode, size: 200 })
      .then((resp) => setSchoolPlans((resp.data && resp.data.rows) || []))
      .catch(() => setSchoolPlansMessage("加载该校课程计划失败。"))
      .finally(() => setSchoolPlansLoading(false));
  }, [schoolDetailCode]);

  const onSearch = () => {
    setPage(1);
    retrieveAll();
  };

  const openCreateEditor = () => {
    setEditingId(null);
    setForm(emptyForm);
    setIsEditorOpen(true);
  };

  const openEditEditor = (item) => {
    const roleNames = (item.roles || []).map((r) => r.name);
    const school =
      item.schoolCode != null ? schoolOptions.find((o) => String(o.value) === String(item.schoolCode)) || null : null;
    setEditingId(item.id);
    setForm({
      username: item.username || "",
      chineseName: item.chineseName || "",
      email: item.email || "",
      phone: item.phone || "",
      password: "",
      roles: roleNames,
      school,
      emailVerified: !!item.emailVerified,
    });
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    setEditingId(null);
    setForm(emptyForm);
    setIsEditorOpen(false);
  };

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const onToggleRole = (roleName) => {
    setForm((prev) => {
      const has = prev.roles.includes(roleName);
      return { ...prev, roles: has ? prev.roles.filter((r) => r !== roleName) : [...prev.roles, roleName] };
    });
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    if (form.roles.length === 0) {
      setMessage("请至少选择一个角色。");
      return;
    }
    if (form.roles.includes("teacher") && !form.school) {
      setMessage("教师角色必须选择所在学校。");
      return;
    }
    const schoolCode = form.roles.includes("teacher") && form.school ? form.school.value : null;
    try {
      if (editingId) {
        const payload = {
          username: form.username,
          chineseName: form.chineseName,
          email: form.email,
          phone: form.phone,
          roles: form.roles,
          schoolCode,
          emailVerified: form.emailVerified,
        };
        if (form.password) payload.password = form.password;
        await AdminUserDataService.update(editingId, payload);
        setMessage("用户信息更新成功。");
      } else {
        await AdminUserDataService.create({
          username: form.username,
          chineseName: form.chineseName,
          email: form.email,
          phone: form.phone,
          password: form.password,
          roles: form.roles,
          schoolCode: schoolCode || undefined,
        });
        setMessage("用户创建成功。");
      }
      closeEditor();
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || (editingId ? "更新失败。" : "创建失败。"));
    }
  };

  const onSuspend = async (item) => {
    const ok = window.confirm(`确定停用用户「${item.chineseName || item.username}」吗？停用后该用户将无法登录。`);
    if (!ok) return;
    try {
      await AdminUserDataService.suspend(item.id);
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };

  const onUnsuspend = async (item) => {
    try {
      await AdminUserDataService.unsuspend(item.id);
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };

  const onDelete = async (item) => {
    const ok = window.confirm(`此操作将永久删除用户「${item.chineseName || item.username}」，且无法撤销。确定继续吗？`);
    if (!ok) return;
    try {
      await AdminUserDataService.delete(item.id);
      setMessage("用户删除成功。");
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    }
  };

  // Defense in depth for direct URL access -- the real security boundary is
  // every backend endpoint's authJwt.isSuper gate; this just avoids rendering
  // a full admin UI (and firing requests that will 403) for a non-super user.
  if (!AuthService.isSuper()) {
    return (
      <div className="container">
        <div className="alert alert-warning mt-3">无权限访问此页面，仅超级管理员可用。</div>
      </div>
    );
  }

  const schoolDetail = schoolDetailCode != null ? findSchoolByCode(schoolDetailCode) : null;

  return (
    <div className="container">
      <h4>用户管理（总数：{totalItems}）</h4>

      <div className="mb-3">
        <div className="form-row">
          <div className="form-group col-md-4">
            <input
              className="form-control"
              placeholder="按用户名/姓名/邮箱搜索"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <div className="form-group col-md-3">
            <select className="form-control" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="">全部角色</option>
              <option value="teacher">教师</option>
              <option value="expert">专家</option>
              <option value="admin">管理员</option>
              <option value="super">超级管理员</option>
            </select>
          </div>
          <div className="form-group col-md-3">
            <select
              className="form-control"
              value={suspendedFilter}
              onChange={(e) => setSuspendedFilter(e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="false">正常</option>
              <option value="true">已停用</option>
            </select>
          </div>
          <div className="form-group col-md-2">
            <button className="btn btn-outline-secondary btn-block" type="button" onClick={onSearch}>
              搜索
            </button>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group col-md-4">
            <Select
              options={schoolOptions}
              value={schoolFilter}
              onChange={(option) => {
                setSchoolFilter(option);
                setPage(1);
              }}
              placeholder="按学校筛选（可按编号/名称/地址搜索）..."
              formatOptionLabel={formatSchoolOptionLabel}
              filterOption={schoolFilterOption}
              isClearable
            />
          </div>
        </div>
      </div>

      <div className="mb-3">
        <button className="btn btn-primary" type="button" onClick={openCreateEditor}>
          新增管理员 / 用户
        </button>
      </div>

      {message && <div className="alert alert-info py-2">{message}</div>}

      <table className="table table-sm table-bordered">
        <thead>
          <tr>
            <th>用户名</th>
            <th role="button" onClick={() => onSortClick("name")}>
              姓名{sortIndicator("name")}
            </th>
            <th>邮箱</th>
            <th>角色</th>
            <th role="button" onClick={() => onSortClick("school")}>
              学校编号{sortIndicator("school")}
            </th>
            <th>邮箱已验证</th>
            <th>状态</th>
            <th>注册时间</th>
            <th role="button" onClick={() => onSortClick("lastLogin")}>
              上次登录时间{sortIndicator("lastLogin")}
            </th>
            <th role="button" onClick={() => onSortClick("totalLoginTime")}>
              累计登录时长{sortIndicator("totalLoginTime")}
            </th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((item) => {
            const isSelf = String(item.id) === currentUserId();
            return (
              <tr key={item.id}>
                <td>{item.username}</td>
                <td>{item.chineseName || "-"}</td>
                <td>{item.email}</td>
                <td>
                  {(item.roles || []).map((r) => (
                    <span key={r.name} className="pl-tag mr-1">
                      {ROLE_LABELS[r.name] || r.name}
                    </span>
                  ))}
                </td>
                <td>
                  {item.schoolCode != null ? (
                    <button className="btn btn-link p-0" type="button" onClick={() => setSchoolDetailCode(item.schoolCode)}>
                      {item.schoolCode}
                    </button>
                  ) : (
                    "-"
                  )}
                </td>
                <td>{item.emailVerified ? "是" : "否"}</td>
                <td>
                  {item.suspended ? <span className="pl-tag-warn">已停用</span> : <span className="text-muted">正常</span>}
                </td>
                <td>{item.createdAt ? new Date(item.createdAt).toLocaleDateString("zh-cn") : "-"}</td>
                <td>
                  {item.lastLogin
                    ? new Date(item.lastLogin).toLocaleString("zh-cn", { hour12: false })
                    : "从未登录"}
                </td>
                <td>{formatDuration(item.totalLoginTime)}</td>
                <td>
                  {isSelf ? (
                    <span className="text-muted">（当前账号）</span>
                  ) : (
                    <>
                      <button className="btn btn-link p-0 mr-2" onClick={() => openEditEditor(item)}>
                        编辑
                      </button>
                      {item.suspended ? (
                        <button className="btn btn-link p-0 mr-2" onClick={() => onUnsuspend(item)}>
                          启用
                        </button>
                      ) : (
                        <button className="btn btn-link p-0 mr-2" onClick={() => onSuspend(item)}>
                          停用
                        </button>
                      )}
                      <button className="btn btn-link p-0 text-danger" onClick={() => onDelete(item)}>
                        删除
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
          {users.length === 0 && (
            <tr>
              <td colSpan="11">暂无数据</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="mt-2 d-flex align-items-center">
        <label className="mr-2 mb-0">每页条数</label>
        <select
          className="form-control form-control-sm"
          style={{ width: "100px" }}
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
        >
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
        </select>
      </div>
      <Pagination
        className="my-3"
        count={totalPages || 1}
        page={page}
        siblingCount={1}
        boundaryCount={1}
        onChange={(event, value) => setPage(value)}
      />

      {schoolDetailCode != null && (
        <div className="pl-drawer-layer">
          <button
            className="pl-drawer-mask"
            type="button"
            onClick={() => setSchoolDetailCode(null)}
            aria-label="close school detail"
          />
          <div className="pl-drawer-panel" style={{ width: "min(420px, 95vw)" }}>
            <div className="pl-drawer-head">
              <h5 className="mb-0">学校信息</h5>
              <button className="btn btn-link p-0" type="button" onClick={() => setSchoolDetailCode(null)}>
                关闭
              </button>
            </div>
            {schoolDetail ? (
              <>
                <table className="table table-sm table-bordered">
                  <tbody>
                    <tr>
                      <th style={{ width: 100 }}>学校编号</th>
                      <td>{schoolDetail.code}</td>
                    </tr>
                    <tr>
                      <th>学校名称</th>
                      <td>{schoolDetail.name}</td>
                    </tr>
                    <tr>
                      <th>地址</th>
                      <td>{schoolDetail.address || "-"}</td>
                    </tr>
                  </tbody>
                </table>

                <h6 className="mt-3 mb-2">该校课程计划（{schoolPlans.length}）</h6>
                {schoolPlansLoading ? (
                  <div className="pl-empty">加载中...</div>
                ) : schoolPlansMessage ? (
                  <div className="alert alert-danger py-2">{schoolPlansMessage}</div>
                ) : schoolPlans.length === 0 ? (
                  <div className="pl-empty">暂无课程计划。</div>
                ) : (
                  <div className="pl-modal-list">
                    {schoolPlans.map((p) => (
                      <Link key={p.id} to={`/plans/${p.id}`} className="pl-modal-row d-block">
                        <div>{p.title || "未命名课程设计"}</div>
                        <div className="text-muted small">
                          {p.Teacher ? p.Teacher.chineseName || p.Teacher.username : "-"}
                          {p.year ? ` · ${p.year}` : ""}
                          {p.season ? ` ${p.season}` : ""}
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-muted">未找到编号为 {schoolDetailCode} 的学校。</p>
            )}
          </div>
        </div>
      )}

      {isEditorOpen && (
        <div className="pl-drawer-layer">
          <button className="pl-drawer-mask" type="button" onClick={closeEditor} aria-label="close editor" />
          <div className="pl-drawer-panel">
            <div className="pl-drawer-head">
              <h5 className="mb-0">{editingId ? "编辑用户" : "新增用户"}</h5>
              <button className="btn btn-link p-0" type="button" onClick={closeEditor}>
                关闭
              </button>
            </div>
            <form onSubmit={onSubmit}>
              <div className="form-group">
                <label>用户名</label>
                <input className="form-control" name="username" value={form.username} onChange={onChange} required />
              </div>
              <div className="form-group">
                <label>姓名</label>
                <input
                  className="form-control"
                  name="chineseName"
                  value={form.chineseName}
                  onChange={onChange}
                  required
                />
              </div>
              <div className="form-group">
                <label>邮箱</label>
                <input
                  className="form-control"
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={onChange}
                  required
                />
              </div>
              <div className="form-group">
                <label>电话</label>
                <input className="form-control" name="phone" value={form.phone} onChange={onChange} />
              </div>
              <div className="form-group">
                <label>{editingId ? "新密码（留空则不修改）" : "密码"}</label>
                <input
                  className="form-control"
                  type="password"
                  name="password"
                  minLength={6}
                  value={form.password}
                  onChange={onChange}
                  required={!editingId}
                />
              </div>
              {editingId && (
                <div className="form-group">
                  <label className="d-flex align-items-center mb-0">
                    <input
                      type="checkbox"
                      className="mr-2"
                      checked={form.emailVerified}
                      onChange={(e) => setForm((prev) => ({ ...prev, emailVerified: e.target.checked }))}
                    />
                    邮箱已验证
                  </label>
                </div>
              )}
              <div className="form-group">
                <label>角色</label>
                <div className="auth-roles-grid">
                  {Object.entries(ROLE_LABELS).map(([name, label]) => {
                    const checked = form.roles.includes(name);
                    return (
                      <label key={name} className={`auth-role-chip${checked ? " is-checked" : ""}`}>
                        <input type="checkbox" checked={checked} onChange={() => onToggleRole(name)} />
                        {label}
                      </label>
                    );
                  })}
                </div>
                {!editingId && (
                  <small className="form-text text-muted">
                    管理员创建的账号无需邮箱验证，创建后即可直接登录。
                  </small>
                )}
              </div>
              {form.roles.includes("teacher") && (
                <div className="form-group">
                  <label>
                    所在学校<span className="required">*</span>
                  </label>
                  <Select
                    options={schoolOptions}
                    value={form.school}
                    onChange={(option) => setForm((prev) => ({ ...prev, school: option }))}
                    placeholder="搜索并选择学校..."
                    formatOptionLabel={formatSchoolOptionLabel}
                    filterOption={schoolFilterOption}
                  />
                </div>
              )}
              <div className="d-flex">
                <button className="btn btn-primary mr-2" type="submit">
                  {editingId ? "保存" : "创建"}
                </button>
                <button className="btn btn-secondary" type="button" onClick={closeEditor}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminUsersList;
