import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'

const DEFAULT_TIMEOUT = 15000

export function createHttpClient(baseHeaders?: Record<string, string>): AxiosInstance {
  return axios.create({
    timeout: DEFAULT_TIMEOUT,
    headers: baseHeaders,
    maxRedirects: 5,
  })
}

export async function httpGet<T = any>(
  url: string,
  opts?: { headers?: Record<string, string>; params?: Record<string, any>; timeout?: number }
): Promise<T> {
  const config: AxiosRequestConfig = {
    timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
    headers: opts?.headers,
    params: opts?.params,
    maxRedirects: 5,
  }
  const resp = await axios.get<T>(url, config)
  return resp.data
}

export async function httpPost<T = any>(
  url: string,
  data?: any,
  opts?: { headers?: Record<string, string>; timeout?: number }
): Promise<T> {
  const config: AxiosRequestConfig = {
    timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
    headers: opts?.headers,
    maxRedirects: 5,
  }
  const resp = await axios.post<T>(url, data, config)
  return resp.data
}

export async function httpPostFull<T = any>(
  url: string,
  data?: any,
  opts?: { headers?: Record<string, string>; timeout?: number }
): Promise<{ data: T; headers: Record<string, any>; status: number }> {
  const config: AxiosRequestConfig = {
    timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
    headers: opts?.headers,
    maxRedirects: 5,
  }
  const resp = await axios.post<T>(url, data, config)
  return { data: resp.data, headers: resp.headers as any, status: resp.status }
}
