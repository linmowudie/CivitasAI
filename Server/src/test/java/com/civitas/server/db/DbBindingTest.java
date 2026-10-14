package com.civitas.server.db;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * `$n` → `?` 占位符翻译 —— 保证 TS 版 SQL 可逐字复用。
 */
class DbBindingTest {

    @Test
    void 顺序占位符翻译为问号() {
        Db.Bound bound = Db.bind("SELECT * FROM users WHERE email_lower = $1 AND status = $2", new Object[]{"a", "active"});
        assertEquals("SELECT * FROM users WHERE email_lower = ? AND status = ?", bound.sql());
        assertArrayEquals(new Object[]{"a", "active"}, bound.params());
    }

    @Test
    void 乱序与重复引用按位置重排参数() {
        Db.Bound bound = Db.bind("INSERT INTO t (a, b, c) VALUES ($3, $1, $1)", new Object[]{"x", "y", "z"});
        assertEquals("INSERT INTO t (a, b, c) VALUES (?, ?, ?)", bound.sql());
        assertArrayEquals(new Object[]{"z", "x", "x"}, bound.params());
    }

    @Test
    void 无占位符原样返回() {
        Db.Bound bound = Db.bind("SELECT 1", new Object[0]);
        assertEquals("SELECT 1", bound.sql());
        assertEquals(0, bound.params().length);
    }

    @Test
    void 混合问号与美元占位符时美元被翻译且问号保留() {
        Db.Bound bound = Db.bind("SELECT * FROM t WHERE a = ? AND b = $1", new Object[]{"b-value"});
        assertEquals("SELECT * FROM t WHERE a = ? AND b = ?", bound.sql());
        assertArrayEquals(new Object[]{"b-value"}, bound.params());
    }

    @Test
    void 占位符越界立即报错() {
        assertThrows(IllegalArgumentException.class,
                () -> Db.bind("SELECT $2", new Object[]{"only-one"}));
    }

    @Test
    void 连接串_userInfo转查询参数() {
        assertEquals("jdbc:postgresql://127.0.0.1:55432/civitas_server_test?user=postgres",
                Db.jdbcUrl("postgres://postgres@127.0.0.1:55432/civitas_server_test"));
    }

    @Test
    void 连接串_保留查询串并编码口令() {
        assertEquals("jdbc:postgresql://db.example.com:5432/civitas?sslmode=require&user=app&password=pa%40ss%2Bword",
                Db.jdbcUrl("postgres://app:pa%40ss%2Bword@db.example.com:5432/civitas?sslmode=require"));
    }

    @Test
    void 连接串_已是Jdbc格式原样返回() {
        assertEquals("jdbc:postgresql://127.0.0.1:5432/x", Db.jdbcUrl("jdbc:postgresql://127.0.0.1:5432/x"));
    }
}
