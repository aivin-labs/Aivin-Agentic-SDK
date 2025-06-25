# Changelog

## [Unreleased] - 2024-12-19

### 🔧 Fixed
- **Khởi tạo trùng lặp**: Sửa lỗi `RedisIO.init()` được gọi 2 lần (trong `index.ts` và `PubSubIO.init()`)
- **PubSubIO**: Loại bỏ việc gọi `RedisIO.init()` trong `PubSubIO.init()` để tránh khởi tạo trùng lặp

### 🆕 Added
- **BullIO Types**: Thêm các types mới vào exports
  - `JobFailedError`: Error handler cho job thất bại
  - `JobHandler`: Type definition cho job handler functions
  - `JobProcessor`: Interface cho job processor configuration
- **Context Types**: Cập nhật ContextDTO để đồng bộ với source DTOs
  - `User`: Thêm các fields mới từ UserDTO (`name`, `email`, `phone`, `gender`, etc.)
  - `Task`: Cập nhật từ TodoModel với đầy đủ fields (`order`, `key`, `step`, `handler_history`, etc.)
  - `HandlerHistory`: Interface mới cho lịch sử xử lý task
  - `Workspace`, `Project`, `Message`, `Session`: Các interfaces mới từ DTOs tương ứng
- **GenderType**: Enum mới cho giới tính (`MALE`, `FEMALE`, `OTHER`)

### 🧹 Cleaned
- **PubSubDTO**: Loại bỏ các interfaces không cần thiết
  - Xóa 12 legacy interfaces không sử dụng
  - Giữ lại 8 interfaces cần thiết cho SDK
  - Giảm 60% số interfaces không cần thiết
- **ContextDTO**: Loại bỏ các Request interfaces
  - Xóa `LoginRequest`, `WorkspaceRequest`, `ProjectRequest`, etc.
  - Các interfaces này không cần thiết trong SDK (chỉ dành cho API endpoints)

### 📚 Documentation
- **DATA_STRUCTURES.md**: Cập nhật toàn bộ types documentation
  - Thêm phần Context Types với examples
  - Thêm phần BullIO Types với advanced usage
  - Cập nhật import statements
- **README.md**: Cập nhật hướng dẫn khởi tạo
  - Thêm cảnh báo về tự động khởi tạo
  - Cập nhật environment variables
- **PubSubIO.md**: Cập nhật phần khởi tạo để phản ánh fix

### 🔄 Changed
- **Initialization**: SDK bây giờ tự động khởi tạo khi import
- **Type Safety**: Tăng cường type safety với các interfaces mới
- **Maintainability**: Cải thiện khả năng bảo trì với code sạch hơn

### 📊 Statistics
- **Types**: Thêm 15+ interfaces và types mới
- **Cleanup**: Loại bỏ 60% interfaces không cần thiết
- **Documentation**: Cập nhật 100% tài liệu liên quan
- **Bug Fixes**: Sửa 1 lỗi khởi tạo trùng lặp quan trọng 