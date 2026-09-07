import React, { useCallback, useEffect, useState } from "react";
import Select from "react-select";
import AuthService from "../services/auth.service";
import { SCHOOLS } from "../constants/school-options";
import "../curriculum.css";

const schoolOptions = SCHOOLS.map((s) => ({ value: s.code, label: s.name }));

const emptyForm = {
  username: "",
  chineseName: "",
  email: "",
  phone: "",
  password: "",
  passwordVerified: "",
};

// Everyone can edit their own user data (except id, which is simply never a
// writable field on PUT /api/auth/users/:id -- see auth.controller.js#update)
// by clicking their own name in the top-right nav. Reuses the same
// GET/PUT /api/auth/users/:id endpoints admin-users-list.component.js's
// admin path uses, gated server-side by authJwt.isSelfOrAdmin instead of
// authJwt.isAdmin -- a self-request for one's own id is always allowed.
const Profile = () => {
  // AuthService.getCurrentUser() re-parses localStorage on every call, so it
  // returns a new object reference each render -- used directly as a
  // useCallback dependency below, that would re-create retrieve() (and thus
  // re-run the fetch effect) on every render, forever. currentUserId is a
  // stable primitive, so the dependency array only actually changes if the
  // logged-in user changes.
  const currentUser = AuthService.getCurrentUser();
  const currentUserId = currentUser ? currentUser.id : null;
  const [form, setForm] = useState(emptyForm);
  const [school, setSchool] = useState(null);
  const [isTeacher, setIsTeacher] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");

  const retrieve = useCallback(async () => {
    if (!currentUserId) return;
    setIsLoading(true);
    try {
      const resp = await AuthService.getProfile(currentUserId);
      const u = resp.data;
      setForm({
        username: u.username || "",
        chineseName: u.chineseName || "",
        email: u.email || "",
        phone: u.phone || "",
        password: "",
        passwordVerified: "",
      });
      const roleNames = (u.roles || []).map((r) => r.name);
      const teacher = roleNames.includes("teacher");
      setIsTeacher(teacher);
      if (teacher && u.schoolCode) {
        const match = schoolOptions.find((o) => String(o.value) === String(u.schoolCode));
        setSchool(match || { value: u.schoolCode, label: u.schoolName || String(u.schoolCode) });
      } else {
        setSchool(null);
      }
    } catch (e) {
      setMessage("加载个人信息失败。");
    } finally {
      setIsLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    retrieve();
  }, [retrieve]);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setMessage("");

    if (form.password && form.password !== form.passwordVerified) {
      setMessage("两次输入的新密码不一致。");
      return;
    }
    if (form.password && form.password.length < 6) {
      setMessage("新密码至少需要6个字符。");
      return;
    }

    if (isTeacher && !school) {
      setMessage("请先选择所在学校。");
      return;
    }

    const payload = {
      username: form.username,
      chineseName: form.chineseName,
      email: form.email,
      phone: form.phone,
    };
    if (form.password) payload.password = form.password;
    if (isTeacher) {
      payload.schoolCode = school.value;
    }

    try {
      await AuthService.updateProfile(currentUser.id, payload);
      setMessage("个人信息已更新。");
      setForm((prev) => ({ ...prev, password: "", passwordVerified: "" }));
      // The top-right nav badge (App.js, a sibling component) reads
      // username/chineseName straight from localStorage but only on its own
      // render -- a same-tab localStorage write alone doesn't trigger React
      // to re-render it. Refresh the stored value, then reload shortly after
      // (same convention login.component.js already uses for any auth-state
      // change) so the nav actually picks it up, after a brief pause so the
      // success message above is visible first.
      const stored = AuthService.getCurrentUser();
      if (stored) {
        stored.username = form.username;
        stored.chineseName = form.chineseName;
        localStorage.setItem("user", JSON.stringify(stored));
      }
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setMessage(err?.response?.data?.message || "更新失败。");
    }
  };

  if (!currentUser) {
    return null;
  }

  return (
    <div className="container pl-page">
      <div className="pl-hero">
        <h4 className="pl-title">个人信息</h4>
        <p className="pl-subtitle">修改您自己的账号信息。</p>
      </div>

      {isLoading ? (
        <div className="pl-empty">加载中...</div>
      ) : (
        <div className="pl-card" style={{ maxWidth: "560px" }}>
          <form onSubmit={onSubmit}>
            <div className="form-group">
              <label>用户名</label>
              <input className="form-control" name="username" value={form.username} onChange={onChange} required />
            </div>
            <div className="form-group">
              <label>姓名</label>
              <input className="form-control" name="chineseName" value={form.chineseName} onChange={onChange} />
            </div>
            <div className="form-group">
              <label>邮箱</label>
              <input className="form-control" type="email" name="email" value={form.email} onChange={onChange} required />
            </div>
            <div className="form-group">
              <label>电话</label>
              <input className="form-control" name="phone" value={form.phone} onChange={onChange} />
            </div>

            {isTeacher && (
              <div className="form-group">
                <label>
                  所在学校<span className="required">*</span>
                </label>
                <Select options={schoolOptions} value={school} onChange={setSchool} placeholder="搜索并选择学校..." />
              </div>
            )}

            <hr />

            <div className="form-group">
              <label>新密码（留空则不修改）</label>
              <input
                className="form-control"
                type="password"
                name="password"
                minLength={6}
                value={form.password}
                onChange={onChange}
              />
            </div>
            <div className="form-group">
              <label>新密码确认</label>
              <input
                className="form-control"
                type="password"
                name="passwordVerified"
                value={form.passwordVerified}
                onChange={onChange}
              />
            </div>

            <button className="btn btn-primary" type="submit">
              保存
            </button>

            {message && <div className="alert alert-info py-2 mt-2 mb-0">{message}</div>}
          </form>
        </div>
      )}
    </div>
  );
};

export default Profile;
