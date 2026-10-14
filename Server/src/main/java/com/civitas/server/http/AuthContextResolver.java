package com.civitas.server.http;

import org.springframework.core.MethodParameter;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

/**
 * {@link AuthContext} 参数解析 —— 与 TS 版 `requireAuth(request)` 对位：
 * 控制器方法声明 {@code AuthContext auth} 参数即可取当前身份（断言已通过 AuthInterceptor）。
 */
public final class AuthContextResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return AuthContext.class.equals(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(
            MethodParameter parameter,
            ModelAndViewContainer mavContainer,
            NativeWebRequest webRequest,
            WebDataBinderFactory binderFactory) {
        AuthContext auth = (AuthContext) webRequest.getAttribute(AuthContext.ATTRIBUTE, RequestAttributes.SCOPE_REQUEST);
        if (auth == null) throw Errors.unauthenticated();
        return auth;
    }
}
