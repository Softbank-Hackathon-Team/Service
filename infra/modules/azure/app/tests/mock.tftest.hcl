mock_provider "azurerm" {}
run "plan" {
  command = plan
  assert {
    condition     = azurerm_postgresql_flexible_server.db[0].public_network_access_enabled == false
    error_message = "DB는 비공개"
  }
}
