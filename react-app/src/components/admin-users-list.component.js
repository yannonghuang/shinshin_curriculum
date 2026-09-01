import React, { useCallback, useEffect, useState } from "react";
import Pagination from "@material-ui/lab/Pagination";
import Select from "react-select";
import AdminUserDataService from "../services/admin-user.service";
import AuthService from "../services/auth.service";
import { SCHOOLS } from "../constants/school-options";
import "../curriculum.css";

const ROLE_LABELS = { teacher: "教师", expert: "专家", admin: "管理员" };
const schoolOptions = SCHOOLS.map((s) => ({ value: s.code, label: s.name }));

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

// Admin-only user management: list/search/paginate, create a user with any role
// (including admin -- public signup can never do that, see verifySignUp.checkNotAdminRole),
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
      });
      setUsers(resp.data.rows || []);
      setTotalPages(resp.data.totalPages || 0);
      setTotalItems(resp.data.totalItems || 0);
    } catch (e) {
      console.log(e);
      setMessage("加载用户列表失败。");
    }
  }, [page, pageSize, keyword, roleFilter, suspendedFilter]);

  useEffect(() => {
    retrieveAll();
  }, [retrieveAll]);

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
    const schoolCode = form.roles.includes("teacher") && form.school ? form.school.value : null;
    const schoolName = form.roles.includes("teacher") && form.school ? form.school.label : null;
    try {
      if (editingId) {
        const payload = {
          username: form.username,
          chineseName: form.chineseName,
          email: form.email,
          phone: form.phone,
          roles: form.roles,
          schoolCode,
          schoolName,
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
          schoolName: schoolName || undefined,
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
  // every backend endpoint's authJwt.isAdmin gate; this just avoids rendering
  // a full admin UI (and firing requests that will 403) for a non-admin.
  if (!AuthService.isAdmin()) {
    return (
      <div className="container">
        <div className="alert alert-warning mt-3">无权限访问此页面，仅管理员可用。</div>
      </div>
    );
  }

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
            <th>姓名</th>
            <th>邮箱</th>
            <th>角色</th>
            <th>邮箱已验证</th>
            <th>状态</th>
            <th>注册时间</th>
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
                <td>{item.emailVerified ? "是" : "否"}</td>
                <td>
                  {item.suspended ? <span className="pl-tag-warn">已停用</span> : <span className="text-muted">正常</span>}
                </td>
                <td>{item.createdAt ? new Date(item.createdAt).toLocaleDateString("zh-cn") : "-"}</td>
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
              <td colSpan="8">暂无数据</td>
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
                  <label>所在学校（可选）</label>
                  <Select
                    options={schoolOptions}
                    value={form.school}
                    onChange={(option) => setForm((prev) => ({ ...prev, school: option }))}
                    isClearable
                    placeholder="搜索并选择学校..."
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
