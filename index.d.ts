/// <reference types="jest" />

declare namespace jest {
    function mockObj(...args: any[]): void;
    function mockFn(...args: any[]): void;
}